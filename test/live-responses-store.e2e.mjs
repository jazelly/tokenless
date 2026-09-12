
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'
import { probeDaemonReady, readDaemonToken } from '../packages/cli/dist/src/index.js'
import { providerRegistry, resolveTaskCapabilityRoutes, TASK_CAPABILITIES } from '../packages/server/dist/src/providers/registry.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('real Responses store controls ledger continuation while retaining job history', { timeout: 900_000 }, async () => {
  assert.equal(process.env.TOKENLESS_LIVE_RESPONSES_STORE, '1', 'Set TOKENLESS_LIVE_RESPONSES_STORE=1 to authorize real provider requests.')
  const target = await resolveConfiguredBrowserTarget()
  assert.equal(target.config.apiProxy.enabled, true, 'Enable the API proxy in the selected test home before this gate.')
  const profileConfig = target.config.profiles[target.profile.slug]
  const provider = profileConfig?.enabledProviders.find((id) => (
    profileConfig.providerModes[id]?.includes('browser')
    && providerRegistry.resolve(id)?.descriptor.stage !== 'disabled'
    && resolveTaskCapabilityRoutes({ requirements: [TASK_CAPABILITIES.CONVERSATION_CHAT], candidates: [{ provider: id, runtimeEligibility: 'unchecked' }], executionMode: 'browser' }).ok
  ))
  assert.ok(provider, 'The configured default profile needs an enabled browser conversation provider.')
  const listed = spawnSync(process.execPath, [
    path.join(root, 'packages/cli/dist/src/tokenless.mjs'),
    'profiles', 'list', '--home', target.homeDir, '--json',
  ], { cwd: root, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(listed.status, 0, 'The built CLI must read the selected production profile registry.')
  const daemon = await probeDaemonReady({ homeDir: target.homeDir })
  assert.equal(daemon.ok, true, 'Start the matching packaged daemon before this gate.')
  const token = await readDaemonToken({ homeDir: target.homeDir })
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + token }
  const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
  const runId = randomUUID().replaceAll('-', '')
  try {
    for (const [route, stream, store] of [
      ['/v1/responses', false, undefined],
      ['/v1/openai/responses', true, true],
      ['/v1/responses', false, false],
      ['/v1/openai/responses', true, false],
    ]) {
      const marker = 'RESPONSES_STORE_' + runId + '_' + String(store) + '_' + String(stream)
      const response = await fetch(daemon.url + route, {
        method: 'POST', headers, signal: AbortSignal.timeout(180_000),
        body: JSON.stringify({
          model: 'tokenless/' + provider,
          input: 'Reply with exactly ' + marker + ' and no other text.',
          stream,
          ...(store === undefined ? {} : { store }),
          tokenless: { execution_mode: 'browser' },
        }),
      })
      assert.equal(response.status, 200, 'The real provider Response must succeed.')
      let body
      if (stream) {
        const frames = (await response.text()).split('\n').filter((line) => line.startsWith('data: '))
          .map((line) => JSON.parse(line.slice(6)))
        body = frames.find((frame) => frame.type === 'response.completed')?.response
      } else {
        body = await response.json()
      }
      assert.ok(body, 'The response must include its terminal public body.')
      assert.ok(body.output_text?.trim() === marker, 'The real provider must return the run marker.')
      assert.equal(body.store, store !== false)
      const saved = database.prepare('SELECT transcript_json FROM api_response_ledger WHERE response_id = ?').get(body.id)
      if (store === false) {
        assert.equal(saved, undefined, 'store:false must not write a response ledger entry.')
        const continuation = await fetch(daemon.url + '/v1/responses', {
          method: 'POST', headers, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ model: 'tokenless/' + provider, input: 'continue', previous_response_id: body.id }),
        })
        assert.equal(continuation.status, 404)
        assert.equal((await continuation.json()).error.code, 'response_not_found')
      } else {
        assert.ok(saved, 'Default storage and store:true must persist the response.')
        assert.ok(saved.transcript_json.includes(marker), 'The stored public transcript must include this run.')
      }
      const job = database.prepare('SELECT status FROM jobs WHERE job_id = ?').get(body.tokenless.job_id)
      assert.equal(job?.status, 'succeeded', 'store:false does not disable ordinary job history.')
    }
    assert.ok(fs.statSync(target.profile.directory).isDirectory(), 'The configured persistent profile must remain intact.')
  } finally {
    database.close()
  }
})
