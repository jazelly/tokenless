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
})

test('CLI state contract exposes daemon blocker_json instead of hiding waiting state', async () => {
  const cli = await fs.readFile(path.join(root, 'packages/cli/src/tokenless.mts'), 'utf8')

  assert.match(cli, /blocker:\s*job\.blocker_json/)
  assert.match(cli, /state:\s*{[\s\S]*blocker:\s*job\.blocker_json/)
  assert.match(cli, /waiting_for_user/)
  assert.match(cli, /visible managed browser is open/i)
})
