import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryUrl = 'git+https://github.com/jazelly/tokenless.git'
const nativePackages = [
  'tokenless-native-darwin-arm64',
  'tokenless-native-darwin-x64',
  'tokenless-native-linux-arm64',
  'tokenless-native-linux-x64',
  'tokenless-native-win32-arm64',
  'tokenless-native-win32-x64',
]

test('Changesets release configuration tracks only the public CLI', () => {
  const config = readJson('.changeset/config.json')
  const rootPackage = readJson('package.json')
  assert.equal(config.access, 'public')
  assert.equal(config.baseBranch, 'main')
  assert.deepEqual(config.ignore.sort(), [
    'tokenless-browser-session-bridge',
    'tokenless-client',
    'tokenless-relay',
  ])
  assert.ok(rootPackage.devDependencies['@changesets/cli'])
  assert.equal(rootPackage.scripts.changeset, 'changeset')
  assert.equal(rootPackage.scripts['release:version'], 'node scripts/release/version.mjs')
})

test('public npm manifests are bound to the canonical repository', () => {
  const cliPackage = readJson('packages/cli/package.json')
  assert.equal(cliPackage.repository.url, repositoryUrl)
  assert.equal(cliPackage.publishConfig.access, 'public')
  assert.deepEqual(Object.keys(cliPackage.optionalDependencies).sort(), nativePackages)

  for (const packageName of nativePackages) {
    const manifest = readJson(`packages/cli/npm/${packageName}/package.json`)
    assert.equal(manifest.repository.url, repositoryUrl)
    assert.equal(manifest.publishConfig.access, 'public')
  }
})

test('npm publishing is marker-gated, platform-complete, and cleans up in a second commit', () => {
  const prepare = readText('.github/workflows/prepare-npm-release.yml')
  const publish = readText('.github/workflows/publish-npm.yml')
  assert.match(prepare, /uses: changesets\/action@v1/)
  assert.match(prepare, /version: npm run release:version/)
  assert.match(publish, /id-token: write/)
  assert.match(publish, /\.changeset\/publish-pending\.json/)
  assert.match(publish, /needs: \[prepare, publish-native\]/)
  assert.match(publish, /git rm \.changeset\/publish-pending\.json/)
  for (const [platform, arch] of [
    ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'],
    ['linux', 'x64'], ['win32', 'arm64'], ['win32', 'x64'],
  ]) {
    assert.match(publish, new RegExp(`platform: ${platform}[\\s\\S]*arch: ${arch}`))
  }
})

test('publish verification is a no-op without the tracked release marker', () => {
  const pending = path.join(root, '.changeset', 'publish-pending.json')
  assert.equal(fs.existsSync(pending), false)
  const result = spawnSync(process.execPath, ['scripts/release/verify-pending.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'publish=false\n')
})

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}
