import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
} from '../packages/cli/dist/src/playwright/index.js'

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

test('Chrome import copies only selected provider cookie auth rows, excludes shared auth stores, disables sync, and leaves source unchanged', async () => {
  const root = await fakeChromeRoot()
  writeSyntheticCookieDb(join(root, 'Default', 'Cookies'), [
    { host_key: 'chatgpt.com', name: 'chatgpt-root', encrypted_value: Buffer.from('opaque-chatgpt') },
    { host_key: '.chatgpt.com', name: 'chatgpt-subdomain', encrypted_value: Buffer.from('opaque-chatgpt-subdomain') },
    { host_key: 'auth.openai.com', name: 'openai-auth', encrypted_value: Buffer.from('opaque-openai') },
    { host_key: 'claude.ai', name: 'claude', encrypted_value: Buffer.from('opaque-claude') },
    { host_key: 'grok.com', name: 'grok', encrypted_value: Buffer.from('opaque-grok') },
    { host_key: 'x.ai', name: 'xai', encrypted_value: Buffer.from('opaque-xai') },
    { host_key: 'x.com', name: 'x-social', encrypted_value: Buffer.from('opaque-x') },
    { host_key: 'twitter.com', name: 'twitter-social', encrypted_value: Buffer.from('opaque-twitter') },
    { host_key: 'gemini.google.com', name: 'gemini', encrypted_value: Buffer.from('opaque-gemini') },
    { host_key: 'accounts.google.com', name: 'google-account', encrypted_value: Buffer.from('opaque-google') },
    { host_key: 'example.com', name: 'unrelated', encrypted_value: Buffer.from('opaque-unrelated') },
    { host_key: 'chatgpt.com', name: 'partitioned-google', encrypted_value: Buffer.from('opaque-partitioned-google'), top_frame_site_key: 'https://accounts.google.com' },
    { host_key: 'grok.com', name: 'partitioned-grok', encrypted_value: Buffer.from('opaque-partitioned-grok'), top_frame_site_key: 'https://grok.com' },
  ])
  await writeFile(join(root, 'Default', 'History'), 'history')
  await writeFile(join(root, 'Default', 'Bookmarks'), 'bookmarks')
  await writeFile(join(root, 'Default', 'Login Data'), 'password db')
  await mkdir(join(root, 'Default', 'Cache'), { recursive: true })
  await writeFile(join(root, 'Default', 'Cache', 'entry'), 'cache')
  await mkdir(join(root, 'Default', 'Extensions'), { recursive: true })
  await writeFile(join(root, 'Default', 'Extensions', 'ext'), 'extension')
  await mkdir(join(root, 'Default', 'Local Storage'), { recursive: true })
  await writeFile(join(root, 'Default', 'Local Storage', 'leveldb'), 'opaque local state')
  await mkdir(join(root, 'Default', 'IndexedDB'), { recursive: true })
  await writeFile(join(root, 'Default', 'IndexedDB', 'provider.indexeddb.leveldb'), 'opaque indexed db')
  await mkdir(join(root, 'Default', 'Service Worker'), { recursive: true })
  await writeFile(join(root, 'Default', 'Service Worker', 'state'), 'opaque service worker state')

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
    providers: ['chatgpt', 'grok', 'gemini'],
  })

  assert.equal(result.syncDisabled, true)
  assert.ok(result.copiedFiles >= 3)
  assert.deepEqual(result.cookieAuth.providers, [
    { provider: 'chatgpt', cookies: 3, supported: true },
    { provider: 'grok', cookies: 3, supported: true },
    { provider: 'gemini', cookies: 0, supported: false },
  ])
  assert.equal(result.cookieAuth.totalCookies, 6)
  assert.deepEqual(readCookieRows(join(destinationDir, 'Default', 'Cookies')), [
    { host_key: 'chatgpt.com', name: 'chatgpt-root', top_frame_site_key: '' },
    { host_key: '.chatgpt.com', name: 'chatgpt-subdomain', top_frame_site_key: '' },
    { host_key: 'auth.openai.com', name: 'openai-auth', top_frame_site_key: '' },
    { host_key: 'grok.com', name: 'grok', top_frame_site_key: '' },
    { host_key: 'x.ai', name: 'xai', top_frame_site_key: '' },
    { host_key: 'grok.com', name: 'partitioned-grok', top_frame_site_key: 'https://grok.com' },
  ])
  assert.deepEqual(readMetaRows(join(destinationDir, 'Default', 'Cookies')), [{ key: 'version', value: '24' }])
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'History')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Bookmarks')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Login Data')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Cache')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Extensions')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Local Storage')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'IndexedDB')), { code: 'ENOENT' })
  await assert.rejects(() => stat(join(destinationDir, 'Default', 'Service Worker')), { code: 'ENOENT' })

  const clonedState = JSON.parse(await readFile(join(destinationDir, 'Local State'), 'utf8'))
  assert.equal(clonedState.sync.disabled, true)
  assert.equal(clonedState.os_crypt.encrypted_key, 'opaque-root-encryption-metadata')
  await assertSourceUnchanged(sourceProof)
})

test('Chrome import does not copy cookie triggers that can inject disallowed rows', async () => {
  const root = await fakeChromeRoot()
  writeSyntheticCookieDb(join(root, 'Default', 'Cookies'), [
    { host_key: 'chatgpt.com', name: 'allowed-chatgpt', encrypted_value: Buffer.from('opaque-chatgpt') },
  ])
  writeCookieTrigger(join(root, 'Default', 'Cookies'), `
    CREATE TRIGGER inject_disallowed_cookie
    AFTER INSERT ON cookies
    WHEN NEW.host_key = 'chatgpt.com'
    BEGIN
      INSERT INTO cookies(creation_utc, host_key, top_frame_site_key, name, value, encrypted_value)
      VALUES (999, 'accounts.google.com', '', 'injected-google', '', X'');
    END;
  `)
  poisonCookieSchemaSql(
    join(root, 'Default', 'Cookies'),
    'CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, PRIMARY KEY(host_key, top_frame_site_key, name)); CREATE TABLE injected_schema_sql(host_key TEXT); --'
  )
  const tokenlessHome = await mkdtemp(join(tmpdir(), 'tokenless-playwright-home-'))
  const destinationDir = join(tokenlessHome, 'browser', 'profiles', crypto.randomUUID())

  const result = await importChromeProfile({
    sourceUserDataDir: root,
    profileDirectoryKey: 'Default',
    destinationDir,
    tokenlessHome,
    providers: ['chatgpt'],
  })

  assert.deepEqual(result.cookieAuth.providers, [
    { provider: 'chatgpt', cookies: 1, supported: true },
  ])
  assert.equal(result.cookieAuth.totalCookies, 1)
  assert.deepEqual(readCookieRows(join(destinationDir, 'Default', 'Cookies')), [
    { host_key: 'chatgpt.com', name: 'allowed-chatgpt', top_frame_site_key: '' },
  ])
  assert.deepEqual(readTriggerRows(join(destinationDir, 'Default', 'Cookies')), [])
  assert.equal(readTableNames(join(destinationDir, 'Default', 'Cookies')).includes('injected_schema_sql'), false)
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
  assert.equal(shouldCopyChromeEntry('Cookies', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Network/Cookies', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Local Storage/leveldb', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('IndexedDB/provider.leveldb', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Session Storage/leveldb', 'profile'), false)
  assert.equal(shouldCopyChromeEntry('Service Worker/ScriptCache', 'profile'), false)
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

function writeSyntheticCookieDb(path, rows) {
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
      INSERT INTO meta(key, value) VALUES ('version', '24');
      CREATE TABLE cookies(
        creation_utc INTEGER NOT NULL,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        encrypted_value BLOB NOT NULL DEFAULT X'',
        PRIMARY KEY(host_key, top_frame_site_key, name)
      );
      CREATE INDEX cookies_host_key_idx ON cookies(host_key);
    `)
    const insert = database.prepare(`
      INSERT INTO cookies(creation_utc, host_key, top_frame_site_key, name, value, encrypted_value)
      VALUES (?, ?, ?, ?, '', ?)
    `)
    let creation = 13_396_451_883_850_632n
    for (const row of rows) {
      insert.run(creation++, row.host_key, row.top_frame_site_key ?? '', row.name, row.encrypted_value)
    }
  } finally {
    database.close()
  }
}

function writeCookieTrigger(path, sql) {
  const database = new DatabaseSync(path)
  try {
    database.exec(sql)
  } finally {
    database.close()
  }
}

function poisonCookieSchemaSql(path, sql) {
  const database = new DatabaseSync(path)
  try {
    database.enableDefensive(false)
    database.exec('PRAGMA writable_schema=ON')
    database.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'cookies'").run(sql)
    database.exec('PRAGMA writable_schema=OFF')
  } finally {
    database.close()
  }
}

function readCookieRows(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT host_key, name, top_frame_site_key FROM cookies ORDER BY creation_utc').all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

function readTriggerRows(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

function readTableNames(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => row.name)
  } finally {
    database.close()
  }
}

function readMetaRows(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT key, value FROM meta ORDER BY key').all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
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
