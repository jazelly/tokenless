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
