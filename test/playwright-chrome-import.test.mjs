import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  TokenlessPlaywrightError,
  assertSourceUnchanged,
  discoverChromeProfiles,
  discoverChromiumProfiles,
  importChromeProfile,
  resolveChromeProfile,
  shouldCopyChromeEntry,
  standardChromiumUserDataDirs,
} from '../packages/playwright/dist/src/index.js'

test('Chrome discovery enumerates exact directory keys from Local State', async () => {
  const root = await fakeChromeRoot()
  const discovered = await discoverChromeProfiles({ userDataDirs: [root] })
  assert.equal(discovered.length, 1)
  assert.deepEqual(discovered[0].profiles.map((profile) => profile.directoryKey), ['Default', 'Profile 1'])

  const profile = await resolveChromeProfile(root, 'Profile 1')
  assert.equal(profile.name, 'Work')
  await assert.rejects(() => resolveChromeProfile(root, '../Default'), matchCode('invalid_chrome_profile_key'))
})

test('Brave discovery uses its platform root and the same exact profile-directory contract', async () => {
  assert.deepEqual(
    standardChromiumUserDataDirs('brave', 'darwin', '/Users/example', {}),
    ['/Users/example/Library/Application Support/BraveSoftware/Brave-Browser']
  )
  const root = await fakeChromeRoot()
  const discovered = await discoverChromiumProfiles({ browser: 'brave', userDataDirs: [root] })
  assert.equal(discovered[0].browser, 'brave')
  assert.deepEqual(discovered[0].profiles.map((profile) => profile.directoryKey), ['Default', 'Profile 1'])
})

test('Chrome import copies opaque auth state, excludes private browsing data, disables sync, and leaves source unchanged', async () => {
  const root = await fakeChromeRoot()
  await writeFile(join(root, 'Default', 'Cookies'), 'opaque cookie db')
  await writeFile(join(root, 'Default', 'History'), 'history')
  await writeFile(join(root, 'Default', 'Bookmarks'), 'bookmarks')
  await writeFile(join(root, 'Default', 'Login Data'), 'password db')
  await mkdir(join(root, 'Default', 'Cache'), { recursive: true })
  await writeFile(join(root, 'Default', 'Cache', 'entry'), 'cache')
  await mkdir(join(root, 'Default', 'Extensions'), { recursive: true })
  await writeFile(join(root, 'Default', 'Extensions', 'ext'), 'extension')
  await mkdir(join(root, 'Default', 'Local Storage'), { recursive: true })
  await writeFile(join(root, 'Default', 'Local Storage', 'leveldb'), 'opaque local state')

  const sourceProof = await sourceSnapshot([
    join(root, 'Local State'),
    join(root, 'Default', 'Cookies'),
    join(root, 'Default', 'History'),
  ])
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const destinationDir = join(tokenlessHome, 'browser', 'profiles', crypto.randomUUID())

  const result = await importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
  })

  assert.equal(result.syncDisabled, true)
  assert.ok(result.copiedFiles >= 3)
  assert.equal(await readFile(join(destinationDir, 'Default', 'Cookies'), 'utf8'), 'opaque cookie db')
  assert.equal(await readFile(join(destinationDir, 'Default', 'Local Storage', 'leveldb'), 'utf8'), 'opaque local state')
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'History')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Bookmarks')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Login Data')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Cache')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Extensions')), { code: 'ENOENT' })

  const clonedState = JSON.parse(await readFile(join(destinationDir, 'Local State'), 'utf8'))
  assert.equal(clonedState.sync.disabled, true)
  assert.equal(clonedState.os_crypt.encrypted_key, 'opaque-root-encryption-metadata')
  await assertSourceUnchanged(sourceProof)
})

test('Chrome hot import ignores root lock files while rejecting symlinks and Tokenless-home sources', async () => {
  const root = await fakeChromeRoot()
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const destinationDir = join(tokenlessHome, 'browser', 'profiles', crypto.randomUUID())

  await writeFile(join(root, 'SingletonLock'), 'locked')
  const hotImport = await importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
  })
  assert.ok(hotImport.copiedFiles > 0)
  await assert.rejects(() => stat(join(destinationDir, 'SingletonLock')), { code: 'ENOENT' })

  await import('node:fs/promises').then((fs) => fs.rm(join(root, 'SingletonLock')))
  try {
    await symlink(join(root, 'Default', 'Cookies'), join(root, 'Default', 'SymlinkedCookies'))
  } catch (error) {
    if (error?.code === 'EPERM') return
    throw error
  }

  await assert.rejects(() => importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
  }), matchCode('chrome_profile_symlink_rejected'))

  const profileParent = join(tokenlessHome, 'browser', 'profiles')
  const entries = await readdir(profileParent).catch(() => [])
  assert.equal(entries.some((entry) => entry.startsWith('.staging-')), false)

  const sourceInsideHome = await fakeChromeRoot(join(tokenlessHome, 'source-chrome'))
  await assert.rejects(() => importChromeProfile({
    sourceUserDataDir: sourceInsideHome,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
  }), matchCode('chrome_profile_inside_tokenless_home'))
})

test('Chrome hot import accepts a source file mutation during best-effort copy', async () => {
  const root = await fakeChromeRoot()
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const destinationDir = join(tokenlessHome, 'browser', 'profiles', crypto.randomUUID())
  let mutated = false

  const result = await importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
    copyFile: async (source, destination) => {
      await copyFile(source, destination)
      if (!mutated && source === join(root, 'Default', 'Preferences')) {
        mutated = true
        await writeFile(source, JSON.stringify({ sync: { requested: true }, mutated: true }))
      }
    },
  })

  assert.equal(mutated, true)
  assert.ok(result.copiedFiles > 0)
  const profileParent = join(tokenlessHome, 'browser', 'profiles')
  const entries = await readdir(profileParent).catch(() => [])
  assert.equal(entries.some((entry) => entry.startsWith('.staging-')), false)
  assert.equal((await stat(destinationDir)).isDirectory(), true)
  await rm(tokenlessHome, { recursive: true, force: true })
})

test('Chrome import rejects destinations outside the managed UUID directory without modifying them', async () => {
  const root = await fakeChromeRoot()
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const unsafeDestination = join(tokenlessHome, 'do-not-delete')
  await mkdir(unsafeDestination)
  await writeFile(join(unsafeDestination, 'sentinel'), 'keep me')

  await assert.rejects(() => importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir: unsafeDestination,
    tokenlessHome,
  }), matchCode('unsafe_managed_profile_destination'))

  assert.equal(await readFile(join(unsafeDestination, 'sentinel'), 'utf8'), 'keep me')
  await rm(tokenlessHome, { recursive: true, force: true })
})

test('Chrome hot import promotes regular copied bytes without source snapshot verification', async () => {
  const root = await fakeChromeRoot()
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const destinationDir = join(tokenlessHome, 'browser', 'profiles', crypto.randomUUID())
  let corrupted = false

  const result = await importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
    copyFile: async (source, destination) => {
      await copyFile(source, destination)
      if (!corrupted && source === join(root, 'Default', 'Preferences')) {
        corrupted = true
        await writeFile(destination, 'corrupt staged bytes')
      }
    },
  })

  assert.equal(corrupted, true)
  assert.ok(result.copiedFiles > 0)
  assert.equal(await readFile(join(destinationDir, 'Default', 'Preferences'), 'utf8'), 'corrupt staged bytes')
  assert.equal((await readFile(join(root, 'Default', 'Preferences'), 'utf8')).includes('requested'), true)
  const profileParent = join(tokenlessHome, 'browser', 'profiles')
  const entries = await readdir(profileParent).catch(() => [])
  assert.equal(entries.some((entry) => entry.startsWith('.staging-')), false)
  assert.equal((await stat(destinationDir)).isDirectory(), true)
  await rm(tokenlessHome, { recursive: true, force: true })
})

test('Chrome import include and exclude rules are conservative', () => {
  assert.equal(shouldCopyChromeEntry('Local State', 'root'), true)
  assert.equal(shouldCopyChromeEntry('Default', 'root'), false)
  assert.equal(shouldCopyChromeEntry('Cookies', 'profile'), true)
  assert.equal(shouldCopyChromeEntry('Network/Cookies', 'profile'), true)
  assert.equal(shouldCopyChromeEntry('History', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Login Data', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Extensions/a', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Code Cache/js', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Sync Data/LevelDB', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Sessions/Session_123', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Sessions/Tabs_123', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Current Session', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Current Tabs', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Last Session', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Last Tabs', 'profile'), false)
})

async function fakeChromeRoot(root = undefined) {
  const userDataDir = root ?? await mkdtemp(join(tmpdir(), 'tokenless-fake-chrome-'))
  await mkdir(join(userDataDir, 'Default'), { recursive: true })
  await mkdir(join(userDataDir, 'Profile 1'), { recursive: true })
  await writeFile(join(userDataDir, 'Local State'), JSON.stringify({
    os_crypt: {
      encrypted_key: 'opaque-root-encryption-metadata',
    },
    profile: {
      info_cache: {
        Default: {
          name: 'Personal',
          is_using_default_name: true,
        },
        'Profile 1': {
          name: 'Work',
          is_using_default_name: false,
        },
      },
    },
    sync: {
      disabled: false,
    },
  }))
  await writeFile(join(userDataDir, 'Default', 'Preferences'), JSON.stringify({
    sync: {
      requested: true,
    },
  }))
  return userDataDir
}

async function sourceSnapshot(paths) {
  return await Promise.all(paths.map(async (path) => {
    const fileStat = await stat(path)
    const digest = createHash('sha256').update(await readFile(path)).digest('hex')
    return {
      path,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: digest,
    }
  }))
}

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}
