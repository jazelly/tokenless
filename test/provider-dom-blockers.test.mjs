import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  VISIBLE_ACTIONS,
  createVisibleActionRequest,
  getProviderInstanceById,
} from '../packages/cli/dist/src/playwright/index.js'
import { withDedicatedTestPage } from './helpers/live-provider-test-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(
  root,
  'test/fixtures/provider-dom/claude/signed-out-challenge/cloudflare-security-verification.html',
)
const provenancePath = fixturePath.replace(/\.html$/u, '.provenance.json')

test('Claude blocker check recognizes the captured Cloudflare security-verification interstitial', {
  timeout: 30000,
}, async () => {
  await withDedicatedTestPage(async ({ page }) => {
    const [fixtureBytes, provenanceText] = await Promise.all([
      fs.readFile(fixturePath),
      fs.readFile(provenancePath, 'utf8'),
    ])
    const fixture = fixtureBytes.toString('utf8')
    const provenance = JSON.parse(provenanceText)
    assert.equal(provenance.schema, 'tokenless.provider-dom-provenance.v1')
    assert.equal(provenance.provider, 'claude')
    assert.equal(provenance.accountState, 'signed-out-challenge')
    assert.equal(provenance.scenario, 'cloudflare-security-verification')
    assert.equal(provenance.source, 'development-visible-provider-session-cdp-observer')
    assert.equal(provenance.containsProviderJavaScript, false)
    assert.equal(provenance.containsSyntheticBehavior, false)
    assert.equal(
      createHash('sha256').update(fixtureBytes).digest('hex'),
      provenance.contentSha256,
    )
    assert.doesNotMatch(fixture, /<script\b|<style\b|a237828eab33ed76/iu)

    await page.route('https://claude.ai/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: fixture,
    }))
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded' })

    const provider = getProviderInstanceById('claude')
    assert.ok(provider, 'Claude provider instance is required')
    const response = await provider.executeAction(
      page,
      createVisibleActionRequest({
        requestId: 'claude-cloudflare-blocker-fixture',
        provider: 'claude',
        action: VISIBLE_ACTIONS.BLOCKER_CHECK,
        payload: {},
      }),
      {
        profileId: 'claude-cloudflare-fixture-profile',
        operationId: 'claude-cloudflare-blocker-check',
      },
    )

    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(response.result.blocked, true)
    assert.deepEqual(response.result.reasons, ['visible_cloudflare_interstitial'])
    assert.deepEqual(response.result.blockers, [{
      kind: 'challenge',
      code: 'visible_cloudflare_interstitial',
      message: 'Visible Cloudflare interstitial is blocking the provider page.',
      userResolvable: true,
      retryable: true,
      visibleProof: 'visible-cloudflare-interstitial-text',
      provider: 'claude',
      url: 'https://claude.ai',
      family: 'cloudflare',
    }])
  }, { visibility: 'headless', viewport: { width: 1100, height: 850 } })
})
