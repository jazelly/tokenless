import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('workspace package names are unscoped and match product roles', () => {
  const packages = Object.fromEntries(
    ['cli', 'client', 'extension', 'relay'].map((folder) => {
      const pkg = readJson(`packages/${folder}/package.json`)
      return [folder, pkg]
    })
  )

  assert.equal(packages.cli.name, 'tokenless')
  assert.equal(packages.client.name, 'tokenless-client')
  assert.equal(packages.extension.name, 'tokenless-browser-session-bridge')
  assert.equal(packages.relay.name, 'tokenless-relay')
  assert.equal(packages.client.private, true)
  assert.equal(packages.extension.private, true)
  assert.equal(packages.relay.private, true)

  for (const pkg of Object.values(packages)) {
    assert.ok(!pkg.name.startsWith('@tokenless/'), `${pkg.name} must not use the unavailable npm scope`)
  }
})

test('public bins expose current product names only', () => {
  const cli = readJson('packages/cli/package.json')
  const relay = readJson('packages/relay/package.json')

  assert.deepEqual(cli.bin, { tokenless: 'src/tokenless.mjs' })
  assert.deepEqual(relay.bin, { 'tokenless-relay': 'src/server.mjs' })
  assertNoLegacyNames(JSON.stringify({ cli, relay }))
})

test('README explains user pain, browser install path, and publish strategy', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

  assert.match(readme, /\[README\.zh-CN\.md\]\(README\.zh-CN\.md\)/)
  assert.match(readme, /AI coding agents often need a second model/)
  assert.match(readme, /npm install -g tokenless/)
  assert.match(readme, /tokenless config --preferred-providers claude,chatgpt,gemini/)
  assert.match(readme, /~\/\.tokenless\/config\.json/)
  assert.match(readme, /packages\/extension\/dist\/extension/)
  assert.match(readme, /The extension is distributed through Chrome Web Store/)
  assert.match(readme, /Do not publish yet:\n\n- `tokenless-relay`\n- `tokenless-client`\n- `tokenless-browser-session-bridge`/)
  assert.match(readme, /## Local Dev Test/)
  assert.match(readme, /## Conversation Mapping/)
  assert.match(readme, /## Provider Selection/)
  assert.match(readme, /preferredProviders/)
  assert.match(readme, /--project-name "Website redesign"/)
  assert.match(readme, /--chat-name "Navbar review"/)
  assert.match(readme, /~\/\.tokenless\/meta\/conversations\.json/)
  assert.match(readme, /extension side panel shows local task history grouped by project and chat/)
  assert.doesNotMatch(readme, /\/Users\/jazelly/)
  assert.match(readme, /npm install -g \.\/packages\/cli/)
  assert.match(readme, /REPO_ROOT="\$\(pwd\)"/)
  assert.match(readme, /ChatGPT-shaped fixture served by Playwright/)
  assert.match(readme, /It does not prove the current production ChatGPT DOM/)
  assert.doesNotMatch(readme, /\/path\/to\/tokenless/)
  assert.match(readme, /tokenless install --extension-id "\$TOKENLESS_EXTENSION_ID" --json/)
  assert.match(readme, /--project-name "Tokenless local dev"/)
  assert.match(readme, /--chat-name "Smoke test"/)
  assert.match(readme, /--project-root "\$REPO_ROOT"/)
  assert.match(readme, /TOKENLESS_LOCAL_OK_48291/)
  assert.doesNotMatch(readme, /ls -lt ~\/\.tokenless\/jobs/)
  assert.doesNotMatch(readme, /Common blockers/)
  assertNoLegacyNames(readme)
})

test('Chinese README mirrors the user-facing local test flow', () => {
  const readme = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')

  assert.match(readme, /## 它解决什么问题/)
  assert.match(readme, /## 用户体验/)
  assert.match(readme, /## 本地开发测试/)
  assert.match(readme, /## 对话映射/)
  assert.match(readme, /--project-name "Website redesign"/)
  assert.match(readme, /--chat-name "Navbar review"/)
  assert.match(readme, /~\/\.tokenless\/meta\/conversations\.json/)
  assert.match(readme, /扩展侧边栏会按项目和聊天显示本地任务历史/)
  assert.doesNotMatch(readme, /\/Users\/jazelly/)
  assert.match(readme, /npm install -g tokenless/)
  assert.match(readme, /tokenless config --preferred-providers claude,chatgpt,gemini/)
  assert.match(readme, /~\/\.tokenless\/config\.json/)
  assert.match(readme, /packages\/extension\/dist\/extension/)
  assert.match(readme, /npm install -g \.\/packages\/cli/)
  assert.match(readme, /REPO_ROOT="\$\(pwd\)"/)
  assert.match(readme, /形似 ChatGPT 的本地 fixture DOM/)
  assert.match(readme, /不证明当前线上 ChatGPT DOM/)
  assert.doesNotMatch(readme, /\/path\/to\/tokenless/)
  assert.match(readme, /tokenless install --extension-id "\$TOKENLESS_EXTENSION_ID" --json/)
  assert.match(readme, /--project-name "Tokenless local dev"/)
  assert.match(readme, /--chat-name "Smoke test"/)
  assert.match(readme, /--project-root "\$REPO_ROOT"/)
  assert.match(readme, /TOKENLESS_LOCAL_OK_48291/)
  assert.doesNotMatch(readme, /ls -lt ~\/\.tokenless\/jobs/)
  assert.doesNotMatch(readme, /常见阻塞/)
  assert.match(readme, /浏览器扩展通过 Chrome 网上应用店、未打包目录或压缩包分发/)
  assertNoLegacyNames(readme)
})

test('CLI config command sets the default provider for run', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-config-'))
  const config = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/src/tokenless.mjs'),
    'config',
    '--preferred-providers',
    'claude,chatgpt,gemini',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(config.status, 0)
  assert.deepEqual(JSON.parse(config.stdout).config.preferredProviders, ['claude', 'chatgpt', 'gemini'])

  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--home',
    homeDir,
    '--no-open',
    '--no-wait',
    '--json',
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_PROVIDER: '' },
    encoding: 'utf8',
  })

  assert.equal(run.status, 0)
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.provider, 'claude')
})

test('CLI run fails fast when extension id is missing', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-missing-extension-'))
  const result = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_EXTENSION_ID: '' },
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'missing_extension_id')
  assert.equal(fs.existsSync(path.join(homeDir, 'jobs')), false)
})

test('CLI rejects placeholder extension ids before writing local jobs or manifests', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-invalid-extension-'))
  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    '<chrome-extension-id>',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(run.status, 1)
  assert.equal(JSON.parse(run.stdout).error.code, 'invalid_extension_id')
  assert.equal(fs.existsSync(path.join(homeDir, 'jobs')), false)

  const install = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/src/tokenless.mjs'),
    'install',
    '--extension-id',
    '<chrome-extension-id>',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(install.status, 1)
  assert.equal(JSON.parse(install.stdout).error.code, 'invalid_extension_id')
})

test('tokenless skill documents npm entrypoints instead of repo-relative CLI paths', () => {
  const skill = fs.readFileSync(path.join(root, 'skills/tokenless/SKILL.md'), 'utf8')

  assert.match(skill, /npx tokenless config --json/)
  assert.match(skill, /~\/\.tokenless\/config\.json/)
  assert.match(skill, /npx tokenless run/)
  assert.doesNotMatch(skill, /packages\/cli/)
  assert.doesNotMatch(skill, /tokenless\.mjs/)
})

test('packed CLI tarball exposes a working tokenless bin for npx', () => {
  const cliDir = path.join(root, 'packages/cli')
  const packOutput = execFileSync('npm', ['pack', '--json'], {
    cwd: cliDir,
    encoding: 'utf8',
  })
  const [pack] = JSON.parse(packOutput)
  const tarball = path.join(cliDir, pack.filename)
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-pack-install-'))

  try {
    execFileSync('npm', ['install', tarball, '--prefix', installDir, '--silent'])
    const config = spawnSync(process.execPath, [
      path.join(installDir, 'node_modules', 'tokenless', 'src', 'tokenless.mjs'),
      'config',
      '--json',
    ], {
      encoding: 'utf8',
    })

    assert.equal(config.status, 0)
    const payload = JSON.parse(config.stdout)
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.config.preferredProviders))
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true })
    fs.rmSync(tarball, { force: true })
  }
})

test('published CLI package includes user-facing README and only the tokenless bin', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: path.join(root, 'packages/cli'),
    encoding: 'utf8',
  })
  const [pack] = JSON.parse(output)
  const paths = pack.files.map((file) => file.path).sort()

  assert.ok(paths.includes('README.md'))
  assert.ok(paths.includes('package.json'))
  assert.ok(paths.includes('src/tokenless.mjs'))
  assert.deepEqual(readJson('packages/cli/package.json').bin, { tokenless: 'src/tokenless.mjs' })

  const cliReadme = fs.readFileSync(path.join(root, 'packages/cli/README.md'), 'utf8')
  assert.match(cliReadme, /npm install -g tokenless/)
  assert.match(cliReadme, /visible ChatGPT, Gemini, or Claude tab/)
  assertNoLegacyNames(cliReadme)
})

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function assertNoLegacyNames(text) {
  assert.doesNotMatch(text, /@tokenless\//)
  assert.doesNotMatch(text, /runner-server/)
  assert.doesNotMatch(text, /local-scale/)
  assert.doesNotMatch(text, /\bscale (install|run|doctor)\b/)
  assert.doesNotMatch(text, /tokenless-scale/)
  assert.doesNotMatch(text, /tokenless-runner-server/)
}
