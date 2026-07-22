import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('tokenless skill stops on waiting_for_user and preserves the same daemon job', async () => {
  const skill = await fs.readFile(path.join(root, 'skills/tokenless/SKILL.md'), 'utf8')

  assert.match(skill, /waiting_for_user/)
  assert.match(skill, /already-open managed browser/)
  assert.match(skill, /same `jobId`\/`taskId`/)
  assert.match(skill, /never retry, reimport, resubmit, or create a replacement job/)
  assert.match(skill, /Do not claim completion until the daemon reports `succeeded`/)
  assert.match(skill, /tokenless profiles list --json/)
  assert.match(skill, /tokenless profiles status --profile/)
  assert.match(skill, /tokenless run \\\s*\n\s*--profile/)
  assert.doesNotMatch(skill, /npx tokenless/)
})

test('tokenless-install skill stays noninteractive for agent sessions', async () => {
  const installSkill = await fs.readFile(path.join(root, 'skills/tokenless-install/SKILL.md'), 'utf8')

  assert.match(installSkill, /tokenless setup --fresh --json/)
  assert.match(installSkill, /tokenless profiles discover/)
  assert.match(installSkill, /--import-browser-profile/)
  assert.match(installSkill, /--consent-local-profile-copy/)
  assert.match(installSkill, /--json/)
  assert.match(installSkill, /Never run bare `tokenless setup`/)
  assert.match(installSkill, /human cannot answer CLI questions/i)
  assert.doesNotMatch(installSkill, /interactive terminal/i)
  assert.doesNotMatch(installSkill, /^```bash\ntokenless setup\n```$/m)
})

test('tokenless-install skill treats upgrade as the canonical maintenance path', async () => {
  const installSkill = await fs.readFile(path.join(root, 'skills/tokenless-install/SKILL.md'), 'utf8')

  assert.match(installSkill, /canonical upgrade path/i)
  assert.match(installSkill, /tokenless upgrade --json/)
  assert.match(installSkill, /npm install --global tokenless@latest/)
  assert.match(installSkill, /unknown command/)
  assert.match(installSkill, /exact CLI entrypoint/)
  assert.match(installSkill, /Earlier successful phases may remain installed; do not claim rollback/)
  assert.match(installSkill, /still attempts the final doctor check after a skill or runtime failure/)
  assert.doesNotMatch(installSkill, /npx skills update/)
})

test('CLI state contract exposes daemon blocker_json instead of hiding waiting state', async () => {
  const cli = await fs.readFile(path.join(root, 'packages/cli/src/tokenless.mts'), 'utf8')

  assert.match(cli, /blocker:\s*job\.blocker_json/)
  assert.match(cli, /state:\s*{[\s\S]*blocker:\s*job\.blocker_json/)
  assert.match(cli, /waiting_for_user/)
  assert.match(cli, /visible managed browser is open/i)
})
