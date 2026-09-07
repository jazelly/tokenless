import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const bundledSkills = path.join(root, 'packages/cli/dist/skills')

test('built CLI synchronizes complete packaged skills across installed agents without setup', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-skill-sync-'))
  const home = path.join(workspace, 'tokenless-home')
  const agents = ['.agents', '.agent', '.codex', '.claude', '.cursor', '.copilot', '.gemini', '.hermes', '.config/opencode', '.pi/agent', '.codeium/windsurf']
  for (const agent of agents) fs.mkdirSync(path.join(workspace, agent), { recursive: true })
  const unrelated = path.join(workspace, '.codex/skills/user-owned/SKILL.md')
  fs.mkdirSync(path.dirname(unrelated), { recursive: true })
  fs.writeFileSync(unrelated, 'User-owned skill.\n')
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TOKENLESS_HOME: home, TOKENLESS_SETUP_SKILL_HOME: workspace },
    encoding: 'utf8', timeout: 15_000,
  })
  try {
    const first = run(['skills', 'sync', '--json'])
    assert.equal(first.status, 0, first.stderr || first.stdout)
    const proof = JSON.parse(first.stdout)
    assert.equal(proof.ok, true)
    assert.equal(proof.source, 'package')
    for (const agent of agents) {
      for (const skill of ['tokenless', 'tokenless-install']) {
        assert.deepEqual(fs.readFileSync(path.join(workspace, agent, 'skills', skill, 'SKILL.md')), fs.readFileSync(path.join(bundledSkills, skill, 'SKILL.md')))
      }
    }
    assert.equal(fs.existsSync(home), false, 'sync must not create configuration, profiles, or a daemon')
    const prompt = path.join(workspace, '.codex/skills/tokenless-install/agents/openai.yaml')
    fs.appendFileSync(prompt, '\n# Stale default prompt\n')
    const staleResource = path.join(workspace, '.codex/skills/tokenless-install/old.txt')
    fs.writeFileSync(staleResource, 'obsolete')
    const doctor = JSON.parse(run(['doctor', '--json']).stdout)
    assert.equal(doctor.checks.skills.ok, false)
    assert.equal(doctor.checks.skills.targets.codex.skills['tokenless-install'].ok, false)
    const repair = run(['skills', 'sync', '--json'])
    assert.equal(repair.status, 0, repair.stderr || repair.stdout)
    assert.equal(JSON.parse(repair.stdout).ok, true)
    assert.deepEqual(fs.readFileSync(prompt), fs.readFileSync(path.join(bundledSkills, 'tokenless-install/agents/openai.yaml')))
    assert.equal(fs.existsSync(staleResource), false)
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'User-owned skill.\n')
    assert.equal(fs.existsSync(home), false)
    const { writeTokenlessConfig } = await import('../packages/cli/dist/server/src/persistence/config.js')
    for (const [language, expected] of [['en', /skills are synchronized/], ['zh-CN', /skills 已同步/]]) {
      await writeTokenlessConfig({ homeDir: home, language })
      const human = run(['skills', 'sync'])
      assert.equal(human.status, 0, human.stderr || human.stdout)
      assert.match(human.stdout, expected)
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
