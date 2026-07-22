import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  TOKENLESS_SKILL_NAMES,
  TOKENLESS_SKILL_SOURCE,
  inspectTokenlessSkills,
  installTokenlessSkills,
} from '../packages/cli/dist/src/setup-workflow.js'
import {
  SETUP_MANAGED_PROFILE_DISCLOSURE,
  SETUP_READINESS_DISCLOSURE,
  createSetupPresenter,
  resolveSetupTerminalCapabilities,
  supportsAnsi,
  supportsAnimation,
} from '../packages/cli/dist/src/setup-presenter.js'

test('setup skill check requires both manifests and canonical GitHub lock metadata', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-setup-skills-'))
  await writeInstalledSkills(home)

  const check = await inspectTokenlessSkills(home)

  assert.equal(check.ok, true)
  assert.equal(check.source, TOKENLESS_SKILL_SOURCE)
  assert.deepEqual(Object.keys(check.skills).sort(), [...TOKENLESS_SKILL_NAMES].sort())
  await fs.rm(home, { recursive: true, force: true })
})

test('setup installs both skills from the canonical repository with telemetry disabled and verifies the result', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-setup-install-'))
  const calls = []
  const result = await installTokenlessSkills({
    home,
    run: async (command, args, options) => {
      calls.push({ command, args: [...args], env: options.env })
      await writeInstalledSkills(home)
    },
  })

  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /^npx(?:\.cmd)?$/)
  assert.deepEqual(calls[0].args, [
    '--yes', 'skills', 'add', 'jazelly/tokenless',
    '--skill', 'tokenless',
    '--skill', 'tokenless-install',
    '--global', '--yes',
  ])
  assert.equal(calls[0].env.DISABLE_TELEMETRY, '1')
  assert.equal(result.check.ok, true)
  await fs.rm(home, { recursive: true, force: true })
})

test('setup presenter keeps interactive setup output compact', () => {
  const stream = captureStream()
  const presenter = createSetupPresenter({
    enabled: true,
    stream,
    env: { NO_COLOR: '1' },
    animation: false,
  })

  presenter.welcome()
  presenter.explain({
    title: 'Agent skills',
    lines: [
      'Tokenless will read local skill manifests before changing anything.',
      'Installation changes only local agent skill files.',
    ],
  })

  const output = stream.output()
  assert.match(output, /Tokenless setup/)
  assert.doesNotMatch(output, /Roadmap/)
  assert.doesNotMatch(output, /Visible-session onboarding/)
  assert.match(output, /Tokenless will read local skill manifests before changing anything/)
  assert.doesNotMatch(output, /\u001b\[/)
})

test('setup prompt capability stays independent from stderr presentation capability', () => {
  assert.deepEqual(resolveSetupTerminalCapabilities({
    json: false,
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    stderr: { isTTY: false },
  }), {
    canPrompt: true,
    canPresent: false,
  })
  assert.deepEqual(resolveSetupTerminalCapabilities({
    json: true,
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    stderr: { isTTY: true },
  }), {
    canPrompt: false,
    canPresent: false,
  })
  assert.deepEqual(resolveSetupTerminalCapabilities({
    json: false,
    stdin: { isTTY: true },
    stdout: { isTTY: false },
    stderr: { isTTY: true },
  }), {
    canPrompt: false,
    canPresent: false,
  })
})

test('setup disclosures state essential boundaries concisely', () => {
  assert.equal(SETUP_MANAGED_PROFILE_DISCLOSURE.length, 1)
  assert.match(SETUP_MANAGED_PROFILE_DISCLOSURE[0], /Keeps sign-ins between jobs/)
  assert.match(SETUP_MANAGED_PROFILE_DISCLOSURE[0], /selected provider cookies only/)
  assert.match(SETUP_MANAGED_PROFILE_DISCLOSURE[0], /other browser data is excluded/)
  assert.equal(SETUP_READINESS_DISCLOSURE.length, 1)
  assert.match(SETUP_READINESS_DISCLOSURE[0], /visible sign-in state/)
  assert.match(SETUP_READINESS_DISCLOSURE[0], /without submitting a prompt/)
})

test('setup presenter cleans animated progress on success and failure', async () => {
  const successStream = captureStream()
  const successTimers = manualTimers()
  const successPresenter = createSetupPresenter({
    enabled: true,
    stream: successStream,
    env: { TERM: 'xterm-256color', TOKENLESS_FORCE_ANIMATION: '1' },
    timers: successTimers,
  })

  const value = await successPresenter.withProgress('Checking visible login state', async () => {
    successTimers.tick()
    return 'ready'
  })

  assert.equal(value, 'ready')
  assert.equal(successTimers.cleared(), 1)
  assert.match(successStream.output(), /\u001b\[2K\u001b\[1G/)
  assert.doesNotMatch(successStream.output(), /\r/)
  assert.match(successStream.output(), /OK.*Checking visible login state/)
  assert.equal(successStream.output().endsWith('\n'), true)

  const failureStream = captureStream()
  const failureTimers = manualTimers()
  const failurePresenter = createSetupPresenter({
    enabled: true,
    stream: failureStream,
    env: { TERM: 'xterm-256color', TOKENLESS_FORCE_ANIMATION: '1' },
    timers: failureTimers,
  })

  await assert.rejects(
    failurePresenter.withProgress('Installing skills', async () => {
      failureTimers.tick()
      throw new Error('install failed')
    }),
    /install failed/,
  )

  assert.equal(failureTimers.cleared(), 1)
  assert.match(failureStream.output(), /\u001b\[2K\u001b\[1G/)
  assert.doesNotMatch(failureStream.output(), /\r/)
  assert.match(failureStream.output(), /X.*Installing skills/)
  assert.equal(failureStream.output().endsWith('\n'), true)
})

test('setup presenter keeps animated progress on one terminal line', async () => {
  const stream = captureStream({ columns: 40 })
  const timers = manualTimers()
  const presenter = createSetupPresenter({
    enabled: true,
    stream,
    env: { NO_COLOR: '1', TERM: 'xterm-256color' },
    timers,
  })

  await presenter.withProgress('Installing and verifying Tokenless agent skills from GitHub', async () => {
    timers.tick()
    timers.tick()
  })

  assert.doesNotMatch(stream.output(), /\r/)
  assert.equal(stream.output().match(/\n/g)?.length, 1)
  for (const write of stream.writes()) {
    const visible = write.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\n$/, '')
    assert.ok(visible.length < stream.columns, `progress write exceeded terminal width: ${visible.length}`)
  }
})

test('setup presenter is silent when disabled and respects reduced terminal environments', async () => {
  const stream = captureStream()
  const presenter = createSetupPresenter({
    enabled: false,
    stream,
    env: { TERM: 'xterm-256color' },
  })

  presenter.welcome()
  presenter.explain({ title: 'Silent', lines: ['No output should be written.'] })
  const result = await presenter.withProgress('No-op progress', async () => 'done')

  assert.equal(result, 'done')
  assert.equal(stream.output(), '')
  assert.equal(supportsAnsi({ NO_COLOR: '1' }), false)
  assert.equal(supportsAnsi({ TERM: 'dumb' }), false)
  assert.equal(supportsAnimation({ TERM: 'dumb' }), false)
  assert.equal(supportsAnimation({ CI: '1' }), false)
})

async function writeInstalledSkills(home) {
  const root = path.join(home, '.agents')
  for (const name of TOKENLESS_SKILL_NAMES) {
    const directory = path.join(root, 'skills', name)
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n`, 'utf8')
  }
  await fs.writeFile(path.join(root, '.skill-lock.json'), JSON.stringify({
    version: 3,
    skills: Object.fromEntries(TOKENLESS_SKILL_NAMES.map((name) => [name, {
      source: 'jazelly/tokenless',
      sourceType: 'github',
      sourceUrl: 'https://github.com/jazelly/tokenless.git',
      skillPath: `skills/${name}/SKILL.md`,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }])),
  }), 'utf8')
}

function captureStream({ columns } = {}) {
  const chunks = []
  return {
    ...(columns === undefined ? {} : { columns }),
    write(chunk) {
      chunks.push(String(chunk))
    },
    output() {
      return chunks.join('')
    },
    writes() {
      return [...chunks]
    },
  }
}

function manualTimers() {
  let callback = null
  let clearCount = 0
  return {
    setInterval(next) {
      callback = next
      return Symbol('timer')
    },
    clearInterval() {
      clearCount += 1
    },
    tick() {
      assert.equal(typeof callback, 'function')
      callback()
    },
    cleared() {
      return clearCount
    },
  }
}
