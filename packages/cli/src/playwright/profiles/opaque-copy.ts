import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tokenlessError } from '../errors.js'
import { resolveChromeProfile } from './chrome-discovery.js'
import { isPathInside } from './registry.js'

const ROOT_PROFILE_FILES = Object.freeze(['Local State', 'First Run', 'Last Version'])
const MANAGED_PROFILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type OpaqueChromiumProfileCopyResult = {
  destinationDir: string
  copiedFiles: number
}

export async function copyOpaqueChromiumProfile(options: {
  sourceUserDataDir: string
  profileDirectoryKey: string
  destinationDir: string
  tokenlessHome: string
}): Promise<OpaqueChromiumProfileCopyResult> {
  const tokenlessHome = resolve(options.tokenlessHome)
  const destinationDir = resolve(options.destinationDir)
  const profilesRoot = resolve(tokenlessHome, 'browser', 'profiles')
  if (dirname(destinationDir) !== profilesRoot || !MANAGED_PROFILE_ID_PATTERN.test(basename(destinationDir))) {
    throw tokenlessError(
      'unsafe_managed_profile_destination',
      'Managed browser profile destination must be a UUID directory directly inside the Tokenless profiles root.',
    )
  }

  const source = await resolveChromeProfile(options.sourceUserDataDir, options.profileDirectoryKey)
  const sourceRoot = resolve(source.userDataDir)
  if (isPathInside(tokenlessHome, sourceRoot)) {
    throw tokenlessError('browser_profile_inside_tokenless_home', 'Refusing to copy a browser profile from Tokenless home.')
  }

  await mkdir(profilesRoot, { recursive: true, mode: 0o700 })
  const staging = join(profilesRoot, `.staging-${randomUUID()}`)
  let copiedFiles = 0
  try {
    await mkdir(staging, { mode: 0o700 })
    const sourceRootReal = await realpath(sourceRoot)
    const sourceProfileReal = await realpath(source.profileDir)
    for (const file of ROOT_PROFILE_FILES) {
      copiedFiles += await copyOpaqueEntry({
        source: join(sourceRoot, file),
        sourceBoundary: sourceRootReal,
        destination: join(staging, file),
        optional: true,
      })
    }
    copiedFiles += await copyOpaqueEntry({
      source: source.profileDir,
      sourceBoundary: sourceProfileReal,
      destination: join(staging, source.directoryKey),
      optional: false,
    })
    await rm(destinationDir, { recursive: true, force: true })
    await rename(staging, destinationDir)
    await chmod(destinationDir, 0o700)
    return { destinationDir, copiedFiles }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

async function copyOpaqueEntry(options: {
  source: string
  sourceBoundary: string
  destination: string
  optional: boolean
}): Promise<number> {
  let metadata
  try {
    metadata = await lstat(options.source)
  } catch (error) {
    if (options.optional && isMissingFile(error)) return 0
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw tokenlessError('browser_profile_symlink_rejected', 'Browser profile copy refuses symbolic links.')
  }
  const sourceReal = await realpath(options.source)
  if (!isPathInside(options.sourceBoundary, sourceReal)) {
    throw tokenlessError('browser_profile_path_escape', 'Browser profile copy refuses path escapes.')
  }
  if (metadata.isDirectory()) {
    await mkdir(options.destination, { recursive: true, mode: 0o700 })
    let copiedFiles = 0
    for (const entry of await readdir(options.source)) {
      copiedFiles += await copyOpaqueEntry({
        source: join(options.source, entry),
        sourceBoundary: options.sourceBoundary,
        destination: join(options.destination, entry),
        optional: false,
      })
    }
    return copiedFiles
  }
  if (!metadata.isFile()) return 0
  await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 })
  await copyFile(options.source, options.destination, fsConstants.COPYFILE_EXCL)
  await chmod(options.destination, 0o600)
  return 1
}

function isMissingFile(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
