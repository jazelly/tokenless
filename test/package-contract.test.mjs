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

  assert.deepEqual(cli.bin, { tokenless: 'dist/src/tokenless.mjs' })
  assert.deepEqual(relay.bin, { 'tokenless-relay': 'dist/src/server.mjs' })
  assertNoLegacyNames(JSON.stringify({ cli, relay }))
})

test('README explains user pain, browser install path, and publish strategy', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

  assert.match(readme, /\[README\.zh-CN\.md\]\(README\.zh-CN\.md\)/)
  assert.match(readme, /Tokenless helps agents save tokens/)
  assert.match(readme, /visible web version of ChatGPT, Claude, or Gemini/)
  assert.match(readme, /## Core Value/)
  assert.match(readme, /## How It Works/)
  assert.match(readme, /## Safety Boundary/)
  assert.match(readme, /npm install -g tokenless/)
  assert.match(readme, /tokenless config --preferred-providers claude,chatgpt,gemini/)
  assert.match(readme, /~\/\.tokenless\/config\.json/)
  assert.match(readme, /packages\/extension\/dist\/extension/)
  assert.match(readme, /Chrome Web Store, an unpacked build, or a zip package/)
  assert.match(readme, /Do not publish yet:\n\n- `tokenless-relay`\n- `tokenless-client`\n- `tokenless-browser-session-bridge`/)
  assert.match(readme, /## Development/)
  assert.match(readme, /No hidden provider backend calls/)
  assert.match(readme, /does not read provider cookies/)
  assert.match(readme, /--project-name "Website redesign"/)
  assert.match(readme, /--chat-name "Navbar review"/)
  assert.doesNotMatch(readme, /\/Users\/jazelly/)
  assert.doesNotMatch(readme, /\/path\/to\/tokenless/)
  assert.match(readme, /tokenless install --extension-id "\$TOKENLESS_EXTENSION_ID" --json/)
  assert.match(readme, /--project-name "Tokenless local dev"/)
  assert.match(readme, /--chat-name "Smoke test"/)
  assert.match(readme, /--project-root "\$\(pwd\)"/)
  assert.match(readme, /TOKENLESS_LOCAL_OK_48291/)
  assert.doesNotMatch(readme, /ls -lt ~\/\.tokenless\/jobs/)
  assert.doesNotMatch(readme, /Common blockers/)
  assertNoLegacyNames(readme)
})

test('Chinese README mirrors the user-facing local test flow', () => {
  const readme = fs.readFileSync(path.join(root, 'README.zh-CN.md'), 'utf8')

  assert.match(readme, /Tokenless 帮 agent 省 token/)
  assert.match(readme, /可见的 ChatGPT、Claude 或 Gemini 网页/)
  assert.match(readme, /## 核心价值/)
  assert.match(readme, /## 它怎么工作/)
  assert.match(readme, /## 安全边界/)
  assert.match(readme, /## 开发/)
  assert.match(readme, /--project-name "Website redesign"/)
  assert.match(readme, /--chat-name "Navbar review"/)
  assert.doesNotMatch(readme, /\/Users\/jazelly/)
  assert.match(readme, /npm install -g tokenless/)
  assert.match(readme, /tokenless config --preferred-providers claude,chatgpt,gemini/)
  assert.match(readme, /~\/\.tokenless\/config\.json/)
  assert.match(readme, /packages\/extension\/dist\/extension/)
  assert.match(readme, /不会调用隐藏的 provider 后端接口/)
  assert.match(readme, /它不读取 provider cookies/)
  assert.doesNotMatch(readme, /\/path\/to\/tokenless/)
  assert.match(readme, /tokenless install --extension-id "\$TOKENLESS_EXTENSION_ID" --json/)
  assert.match(readme, /--project-name "Tokenless local dev"/)
  assert.match(readme, /--chat-name "Smoke test"/)
  assert.match(readme, /--project-root "\$\(pwd\)"/)
  assert.match(readme, /TOKENLESS_LOCAL_OK_48291/)
  assert.doesNotMatch(readme, /ls -lt ~\/\.tokenless\/jobs/)
  assert.doesNotMatch(readme, /常见阻塞/)
  assert.match(readme, /Chrome Web Store、未打包目录或 zip 包/)
  assertNoLegacyNames(readme)
})

test('CLI config command sets defaults for run', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-config-'))
  const config = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'config',
    '--preferred-providers',
    'claude,chatgpt,gemini',
    '--browser',
    'brave-browser',
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(config.status, 0)
  assert.deepEqual(JSON.parse(config.stdout).config.preferredProviders, ['claude', 'chatgpt', 'gemini'])
  assert.equal(JSON.parse(config.stdout).config.browser, 'brave')

  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
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
  assert.doesNotMatch(run.stdout, /\[tokenless\]/)
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.provider, 'claude')
  assert.equal(payload.status, 'no_wait')
  assert.deepEqual(payload.statusLog.map((event) => event.event), ['daemon_unavailable', 'created', 'not_opened', 'detached'])
  const request = JSON.parse(fs.readFileSync(path.join(homeDir, 'jobs', payload.requestPath), 'utf8'))
  assert.equal(request.metadata.browser, 'brave')

  const override = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--browser',
    'edge',
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

  assert.equal(override.status, 0)
  const overridePayload = JSON.parse(override.stdout)
  const overrideRequest = JSON.parse(fs.readFileSync(path.join(homeDir, 'jobs', overridePayload.requestPath), 'utf8'))
  assert.equal(overrideRequest.metadata.browser, 'edge')
})

test('CLI run falls back to bundled extension id when no extension id is configured', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-default-extension-'))
  const result = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--home',
    homeDir,
    '--no-open',
    '--no-wait',
    '--json',
  ], {
    cwd: root,
    env: { ...process.env, TOKENLESS_EXTENSION_ID: '' },
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.match(payload.taskUrl, /^chrome-extension:\/\/afpfljlnhlpkbkmgonoanbmcdmmfmoam\//)
  assert.equal(fs.existsSync(path.join(homeDir, 'jobs')), true)
})

test('CLI run falls back to task page transport when daemon is unavailable', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-daemon-fallback-'))
  const result = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--home',
    homeDir,
    '--daemon-url',
    'http://127.0.0.1:9',
    '--no-open',
    '--no-wait',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.transport, undefined)
  assert.match(payload.taskUrl, /^chrome-extension:\/\/abcdefghijklmnopabcdefghijklmnop\/task\/task\.html\?/)
  assert.deepEqual(payload.statusLog.map((event) => event.event), ['daemon_unavailable', 'created', 'not_opened', 'detached'])
  assert.equal(payload.statusLog[0].status, 'fallback_task_page')
  assert.equal(fs.existsSync(path.join(homeDir, 'jobs', payload.requestPath)), true)
})

test('CLI default output reports local job status for agents', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-status-'))
  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--home',
    homeDir,
    '--no-open',
    '--no-wait',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(run.status, 0)
  assert.match(run.stdout, /^\[tokenless\] created status=queued provider=chatgpt action=submit_and_read/m)
  assert.match(run.stdout, /^\[tokenless\] not_opened status=waiting_for_external_open provider=chatgpt/m)
  assert.match(run.stdout, /^\[tokenless\] detached status=no_wait provider=chatgpt/m)
  assert.match(run.stdout, /"status": "no_wait"/)
  assert.match(run.stdout, /"statusLog": \[/)
})

test('CLI exposes stable task ids and state lookup for agents', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-cli-task-state-'))
  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'hello',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--home',
    homeDir,
    '--project-name',
    'Tokenless',
    '--chat-name',
    'State query',
    '--no-open',
    '--no-wait',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(run.status, 0)
  const payload = JSON.parse(run.stdout)
  assert.equal(payload.taskId, 'project:Tokenless:chat:State query')
  assert.equal(payload.idempotencyKey, payload.taskId)
  assert.equal(payload.statusLog[0].taskId, payload.taskId)

  const state = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'state',
    '--task-id',
    payload.taskId,
    '--home',
    homeDir,
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(state.status, 0)
  const statePayload = JSON.parse(state.stdout)
  assert.equal(statePayload.ok, true)
  assert.equal(statePayload.taskId, payload.taskId)
  assert.equal(statePayload.latest.jobId, payload.jobId)
  assert.equal(statePayload.latest.status, 'queued')
  assert.equal(statePayload.latest.state.status, 'queued')
  assert.equal(statePayload.latest.result, null)
  assert.equal(statePayload.latest.nonce, undefined)
  assert.equal(statePayload.latest.prompt, undefined)

  const continuation = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'run',
    '--prompt',
    'continue',
    '--extension-id',
    'abcdefghijklmnopabcdefghijklmnop',
    '--home',
    homeDir,
    '--task-id',
    payload.taskId,
    '--no-open',
    '--no-wait',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(continuation.status, 0)
  const continuationPayload = JSON.parse(continuation.stdout)
  assert.equal(continuationPayload.taskId, payload.taskId)
  assert.equal(continuationPayload.idempotencyKey, payload.taskId)
})

test('CLI rejects placeholder extension ids before writing local jobs or manifests', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-invalid-extension-'))
  const run = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
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
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
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
      path.join(installDir, 'node_modules', 'tokenless', 'dist', 'src', 'tokenless.mjs'),
      'config',
      '--json',
    ], {
      encoding: 'utf8',
    })

    assert.equal(config.status, 0)
    const payload = JSON.parse(config.stdout)
    assert.equal(payload.ok, true)
    assert.ok(Array.isArray(payload.config.preferredProviders))
    assert.equal(payload.config.browser, null)
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
  assert.ok(paths.includes('dist/src/default-extension-id.js'))
  assert.ok(paths.includes('dist/src/tokenless.mjs'))
  assert.deepEqual(readJson('packages/cli/package.json').bin, { tokenless: 'dist/src/tokenless.mjs' })

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
