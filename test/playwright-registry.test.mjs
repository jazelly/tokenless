import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import test from 'node:test'
import {
  ManagedProfileRegistry,
  TokenlessPlaywrightError,
} from '../packages/playwright/dist/src/index.js'

test('managed profile registry resolves explicit/default profiles without using slugs as directories', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tokenless-playwright-registry-')))
  const registry = new ManagedProfileRegistry(home)

  const personal = await registry.addProfile({ slug: 'personal', label: 'Personal', setDefault: true })
  const work = await registry.addProfile({ slug: 'work' })

  assert.equal((await registry.resolveProfile()).id, personal.id)
  assert.equal((await registry.resolveProfile('work')).id, work.id)
  assert.equal(basename(personal.directory), personal.id)
  assert.notEqual(basename(personal.directory), personal.slug)

  const registryFile = join(home, 'browser', 'profiles.json')
  const mode = (await stat(registryFile)).mode & 0o777
  assert.equal(mode, 0o600)

  const raw = JSON.parse(await readFile(registryFile, 'utf8'))
  assert.equal(raw.defaultProfile, 'personal')
  assert.equal(raw.profiles.personal.directory, personal.directory)
})

test('managed profile registry rejects unknown profiles, unsafe slugs, and unconfirmed delete', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tokenless-playwright-registry-')))
  const registry = new ManagedProfileRegistry(home)
  await registry.addProfile({ slug: 'default', setDefault: true })

  assert.throws(() => new ManagedProfileRegistry(home).profileDirectory('../escape'), /invalid/i)
  await assert.rejects(() => registry.resolveProfile('missing'), matchCode('profile_not_found'))
  await assert.rejects(() => registry.addProfile({ slug: '../escape' }), matchCode('invalid_profile_slug'))
  await assert.rejects(() => registry.removeProfile('default', { confirmDelete: false }), matchCode('profile_delete_confirmation_required'))

  const removed = await registry.removeProfile('default', { confirmDelete: true })
  assert.equal(removed.lifecycle, 'removed')
  await assert.rejects(() => registry.resolveProfile(), matchCode('profile_not_configured'))
})

test('managed profile registry stores bounded provider status updates', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tokenless-playwright-registry-')))
  const registry = new ManagedProfileRegistry(home)
  await registry.addProfile({ slug: 'default' })
  await registry.markImported('default', {
    source: 'Google Chrome Default',
    profileDirectoryKey: 'Default',
    importedAt: new Date().toISOString(),
    providers: ['chatgpt', 'claude'],
  })
  const updated = await registry.updateProviderStatus('default', {
    provider: 'chatgpt',
    auth: 'authenticated',
    checkedAt: new Date().toISOString(),
  })
  assert.equal(updated.lastObservedAuth.chatgpt?.auth, 'authenticated')
  assert.equal((await registry.resolveProfile('default')).import?.profileDirectoryKey, 'Default')
  assert.deepEqual((await registry.resolveProfile('default')).import?.providers, ['chatgpt', 'claude'])
})

test('managed profile registry serializes concurrent mutations from independent instances', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tokenless-playwright-registry-')))
  const slugs = Array.from({ length: 16 }, (_, index) => `profile-${index}`)

  await Promise.all(slugs.map((slug, index) => new ManagedProfileRegistry(home).addProfile({
    slug,
    label: `Profile ${index}`,
    setDefault: index === 0,
  })))

  const registry = new ManagedProfileRegistry(home)
  const profiles = await registry.listProfiles()
  assert.deepEqual(profiles.map((profile) => profile.slug).sort(), slugs.sort())
  assert.equal((await registry.resolveProfile()).slug, 'profile-0')
})

function matchCode(code) {
  return (error) => error instanceof TokenlessPlaywrightError && error.code === code
}
