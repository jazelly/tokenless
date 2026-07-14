import assert from 'node:assert/strict'
import test from 'node:test'

import { tokenlessHome } from '../packages/cli/dist/src/job-store.js'
import { createManagedAccountPoolStore } from '../packages/cli/dist/src/direct/codex-account-admin.js'
import { createManagedCodexProjectExecutor } from '../packages/cli/dist/src/direct/managed-codex-executor.js'

const LIVE_MODEL = 'gpt-5.3-codex-spark'
const enabled = process.env.TOKENLESS_LIVE_MANAGED_CODEX === '1'

test('live managed Codex uses an explicitly configured project binding', { skip: !enabled }, async () => {
  assert.equal(
    process.env.TOKENLESS_LIVE_MANAGED_CODEX_CONFIRM,
    'I_ACCEPT_SUBSCRIPTION_USAGE',
    'Set TOKENLESS_LIVE_MANAGED_CODEX_CONFIRM=I_ACCEPT_SUBSCRIPTION_USAGE to authorize this live subscription request.',
  )
  const projectId = process.env.TOKENLESS_LIVE_MANAGED_PROJECT
  assert.match(
    projectId ?? '',
    /^[A-Za-z0-9](?:[A-Za-z0-9._~-]{0,126}[A-Za-z0-9])?$/,
    'TOKENLESS_LIVE_MANAGED_PROJECT must name an existing explicit ChatGPT project binding.',
  )

  const homeDir = tokenlessHome()
  const store = createManagedAccountPoolStore({ homeDir })
  const resolution = await store.resolve({ projectId, provider: 'chatgpt' })
  assert.ok(resolution, 'The live project must already have an explicit ChatGPT binding.')
  assert.equal(resolution.account.driver, 'official-codex')
  assert.equal(resolution.account.status, 'ready')
  assert.equal(resolution.account.enabled, true)

  const executor = createManagedCodexProjectExecutor()
  const text = await executor({
    homeDir,
    projectId,
    initialBinding: resolution.binding,
    initialAccount: resolution.account,
    request: Object.freeze({
      input: 'Return exactly TOKENLESS_LIVE_MANAGED_CODEX_OK.',
      model: LIVE_MODEL,
      stream: false,
      store: false,
    }),
    signal: new AbortController().signal,
  })
  assert.match(text, /TOKENLESS_LIVE_MANAGED_CODEX_OK/)
})
