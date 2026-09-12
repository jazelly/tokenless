import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { JobStore, publicView } from '../packages/cli/dist/server/src/jobs/store.js'
import { writeTokenlessConfig, readTokenlessConfig } from '../packages/cli/dist/server/src/persistence/config.js'
import { createManagedPlaywrightJobRequest } from '../packages/cli/dist/server/src/browser/job-contract.js'
import { createInProcessDaemonClient } from '../packages/cli/dist/server/src/runtime/in-process-client.js'
import { ManagedPlaywrightRunnerService } from '../packages/cli/dist/server/src/browser/runner-service.js'
import { resolveTaskCapabilityRoute, getProviderInstanceById } from '../packages/cli/dist/server/src/providers/registry.js'
import { providerRateLimitTable } from '../packages/cli/dist/server/src/providers/rate-limit-table.js'
import { resolveTestConfig } from './helpers/configured-browser-profile.mjs'

test('persisted rules drive atomic admission, Dashboard usage, and runner fallback without provider execution', { timeout: 30000 }, async () => {
  const { profile } = await resolveTestConfig() // Read the configured profile; never open or modify its browser.
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-local-limits-'))
  const rules = [
    { id: 'chatgpt.hour', provider: 'chatgpt', requestType: 'submission', scope: 'provider', windowSeconds: 3600, maxRequests: 20 },
    { id: 'chatgpt.ten-minutes', provider: 'chatgpt', requestType: 'submission', scope: 'provider', windowSeconds: 600, maxRequests: 10 },
  ]
  await writeTokenlessConfig({ homeDir, rateLimits: rules })
  let store = await JobStore.open(homeDir)
  const db = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'))
  let runner
  function job(provider = 'chatgpt', profileId = profile.slug, extra = {}) {
    const request = createManagedPlaywrightJobRequest({ provider, actions: [
      { action: 'prompt.input', payload: { text: 'Local admission check. This prompt must not be sent.' } },
      { action: 'prompt.submit' }, { action: 'response.read' },
    ], ...extra })
    const created = store.createJob({ job_id: `tlp_${randomUUID()}`, provider, profile_id: profileId, request_json: request })
    return store.takeNextJob({ provider, job_id_prefix: created.job_id }, profileId)
  }
  function projection(provider = 'chatgpt', request = { actions: [{ action: 'prompt.submit' }] }) {
    return store.projectProviderCapacity({ provider, profile_id: profile.slug, access_class: 'signed_in_paid', tier_label: 'Pro', request_json: request })
  }
  function internal(projection, id) { return projection.rules.find((r) => r.ruleId === id) }
  try {
    // Race a cohort through the real in-process daemon client and SQLite transactions.
    const client = createInProcessDaemonClient(store)
    const cohort = Array.from({ length: 11 }, (_, index) => job('chatgpt', index % 2 ? 'second-local-caller' : profile.slug))
    const results = await Promise.all(cohort.map((j) => client.admitProviderAction({ jobId: j.job_id, actionIndex: 1 })))
    assert.equal(results.filter((r) => r.decision !== 'defer').length, 10)
    assert.equal(results.filter((r) => r.decision === 'defer').length, 1)
    assert.equal(internal(projection(), 'chatgpt.ten-minutes').usedUnits, 10)
    assert.equal(db.prepare('SELECT count(*) AS n FROM provider_rate_limit_attempts').get().n, 10)
    // Failed/canceled work retains its attempted usage.
    await store.cancelJob(cohort[0].job_id, 'local test ended')
    assert.equal(internal(projection(), 'chatgpt.ten-minutes').usedUnits, 10)

    // Move the real admission records out of the short window, but keep them in the hour.
    db.prepare('UPDATE provider_rate_limit_attempts SET attempted_at = ?').run(new Date(Date.now() - 660000).toISOString())
    assert.equal(internal(projection(), 'chatgpt.ten-minutes').usedUnits, 0)
    for (let n = 0; n < 10; n++) assert.notEqual(store.admitProviderAction(job().job_id, 1).decision, 'defer')
    const full = projection()
    assert.equal(internal(full, 'chatgpt.hour').usedUnits, 20)
    assert.equal(full.decision, 'defer')
    assert.ok(internal(full, 'chatgpt.hour').eligibleAt)

    // The table consumes exactly the persisted rules and the same usage calculator.
    const config = await readTokenlessConfig(homeDir)
    const table = providerRateLimitTable([{ id: 'chatgpt', label: 'ChatGPT' }], store.configuredRateLimitUsage(config.rateLimits, [profile.slug]))
    for (const rule of rules) {
      const row = table.rules.find((r) => r.id === rule.id)
      assert.equal(row.enforcement, 'enforced')
      assert.equal(row.count, rule.maxRequests)
      assert.equal(row.usage[0].used, internal(full, rule.id).usedUnits)
    }

    // The actual runner takes the fallback branch. Both providers are locally full,
    // so the entire operation ends before either provider page is acquired.
    const claudeRule = { ...rules[0], id: 'claude.minute', provider: 'claude', windowSeconds: 60, maxRequests: 1 }
    await writeTokenlessConfig({ homeDir, rateLimits: [...rules, claudeRule] })
    assert.notEqual(store.admitProviderAction(job('claude').job_id, 1).decision, 'defer')
    const route = resolveTaskCapabilityRoute({ requirements: ['conversation.chat'], candidates: [{ provider: 'claude', runtimeEligibility: 'unchecked' }] })
    assert.equal(route.ok, true)
    const fallback = { protocol: 'tokenless.provider-fallback.v1', mode: 'automatic', replay: 'from_start', alternatives: [{
      provider: 'claude', target: { kind: 'provider_home', url: getProviderInstanceById('claude').navigation.homeTarget().href }, capabilityRoute: route.route,
    }] }
    const primaryRoute = resolveTaskCapabilityRoute({ requirements: ['conversation.chat'], candidates: [{ provider: 'chatgpt', runtimeEligibility: 'unchecked' }] })
    assert.equal(primaryRoute.ok, true)
    assert.equal(projection().decision, 'defer')
    assert.equal(projection('claude').decision, 'defer')
    const routed = job('chatgpt', profile.slug, { fallback, capabilityRoute: primaryRoute.route })
    runner = new ManagedPlaywrightRunnerService({ homeDir, daemonClient: createInProcessDaemonClient(store) })
    await runner.executeJob(profile, publicView(routed))
    const final = store.getJob(routed.job_id)
    assert.equal(final.provider, 'claude')
    assert.equal(final.status, 'failed')
    assert.equal(final.provider_submitted_at, null)
    assert.equal(final.request_json.routingObservation.attempts[0].provider, 'chatgpt')
    assert.equal(final.request_json.routingObservation.attempts[0].reason, 'capacity')
    assert.equal(db.prepare('SELECT count(*) AS n FROM provider_rate_limit_attempts WHERE job_id = ?').get(routed.job_id).n, 0)
    await runner.detach()
    runner = null

    // Rule changes take effect without rebuilding and do not clear prior usage.
    const changed = rules.map((r) => ({ ...r, maxRequests: 30 }))
    const imageRule = { ...rules[0], id: 'chatgpt.images', requestType: 'image', maxRequests: 1 }
    await writeTokenlessConfig({ homeDir, rateLimits: [...changed, imageRule] })
    const imageJob = job('chatgpt', profile.slug, { actions: [
      { action: 'prompt.input', payload: { text: 'Local-only image admission.' } },
      { action: 'prompt.submit' }, { action: 'response.read' },
    ] })
    // Use the real request metadata for modality; no provider result is simulated.
    db.prepare("UPDATE jobs SET request_json = json_set(request_json, '$.context.requirements', json(?)) WHERE job_id = ?").run('["image.generation"]', imageJob.job_id)
    assert.notEqual(store.admitProviderAction(imageJob.job_id, 1).decision, 'defer')
    assert.equal(projection('chatgpt', { context: { requirements: ['image.generation'] }, actions: [{ action: 'prompt.submit' }] }).decision, 'defer')
    assert.notEqual(projection().decision, 'defer')
    const before = internal(projection(), 'chatgpt.hour').usedUnits
    store.close()
    store = await JobStore.open(homeDir)
    assert.equal(internal(projection(), 'chatgpt.hour').usedUnits, before)
    await assert.rejects(writeTokenlessConfig({ homeDir, rateLimits: [{ ...rules[0], maxRequests: 0 }] }))
  } finally {
    await runner?.detach()
    db.close()
    store.close()
    await fs.rm(homeDir, { recursive: true, force: true })
  }
})
