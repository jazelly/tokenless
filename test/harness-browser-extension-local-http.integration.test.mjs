import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createAgentRunHttpHandler } from '../packages/harness/dist/src/index.js'
import { ManagedProfileRegistry } from '../packages/server/dist/src/browser/profiles/registry.js'
import { serveHttp } from '../packages/server/dist/src/http/server.js'
import { JobStore } from '../packages/server/dist/src/jobs/store.js'

test('built daemon pairs and revokes one extension-scoped Harness credential without granting daemon control', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-harness-extension-')))
  const homeDir = path.join(root, 'home')
  const store = await JobStore.open(homeDir)
  const daemon = await serveHttp({
    store,
    host: '127.0.0.1',
    port: 0,
    agentRunHandlerFactory: createAgentRunHttpHandler,
  })
  daemon.activate()
  try {
    const profile = await new ManagedProfileRegistry(homeDir).addProfile({ slug: 'extension-route' })
    const extensionId = 'a'.repeat(32)
    const extensionOrigin = `chrome-extension://${extensionId}`
    const extensionHeaders = { 'content-type': 'application/json', origin: extensionOrigin }

    const preflight = await fetch(`${daemon.origin}/v1/harness/browser-extension/pairings`, {
      method: 'OPTIONS',
      headers: {
        origin: extensionOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-private-network': 'true',
      },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin)
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true')

    const mismatched = await fetch(`${daemon.origin}/v1/harness/browser-extension/pairings`, {
      method: 'POST',
      headers: extensionHeaders,
      body: JSON.stringify({ extensionId: 'b'.repeat(32), extensionVersion: '0.1.0' }),
    })
    assert.equal(mismatched.status, 403)

    const created = await jsonFetch(`${daemon.origin}/v1/harness/browser-extension/pairings`, {
      method: 'POST',
      headers: extensionHeaders,
      body: JSON.stringify({ extensionId, extensionVersion: '0.1.0' }),
    }, 201)
    assert.match(created.pairingId, /^pairing:[a-f0-9]{32}$/)
    assert.equal(new URL(created.dashboardUrl).origin, daemon.origin)
    assert.equal(new URL(created.dashboardUrl).searchParams.get('harnessPairing'), created.pairingId)

    const dashboard = await fetch(`${daemon.origin}/dashboard/overview/`)
    assert.equal(dashboard.status, 200)
    const cookie = dashboard.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)
    const session = await jsonFetch(`${daemon.origin}/dashboard-api/v1/session`, {
      headers: { cookie },
    })
    const dashboardPairing = await jsonFetch(
      `${daemon.origin}/dashboard-api/v1/harness/browser-extension/pairings/${encodeURIComponent(created.pairingId)}`,
      { headers: { cookie } },
    )
    assert.deepEqual({
      extensionId: dashboardPairing.extensionId,
      extensionVersion: dashboardPairing.extensionVersion,
      state: dashboardPairing.state,
    }, { extensionId, extensionVersion: '0.1.0', state: 'pending' })

    const mutationHeaders = {
      cookie,
      origin: daemon.origin,
      'content-type': 'application/json',
      'x-tokenless-csrf': session.csrf,
    }
    const approved = await jsonFetch(
      `${daemon.origin}/dashboard-api/v1/harness/browser-extension/pairings/${encodeURIComponent(created.pairingId)}/approve`,
      {
        method: 'POST',
        headers: mutationHeaders,
        body: JSON.stringify({ provider: 'chatgpt', profileId: profile.slug }),
      },
    )
    assert.equal(approved.status, 'active')
    assert.equal(Object.hasOwn(approved, 'credential'), false)

    const polled = await jsonFetch(
      `${daemon.origin}/v1/harness/browser-extension/pairings/${encodeURIComponent(created.pairingId)}/poll`,
      {
        method: 'POST',
        headers: extensionHeaders,
        body: JSON.stringify({ secret: created.secret }),
      },
    )
    assert.equal(polled.state, 'approved')
    assert.equal(polled.provider, 'chatgpt')
    assert.equal(polled.profileId, profile.slug)
    assert.match(polled.credential, /^extension-credential:[a-f0-9]{32}$/)

    const pairingFile = fs.readFileSync(path.join(homeDir, 'harness-extension-pairings.json'), 'utf8')
    assert.equal(pairingFile.includes(polled.credential), true)
    assert.equal(pairingFile.includes(created.secret), false)
    assert.equal(JSON.parse(pairingFile)[0].credentialHash.length, 64)
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(homeDir, 'harness-extension-pairings.json')).mode & 0o777, 0o600)

    const connection = await jsonFetch(`${daemon.origin}/v1/harness/browser-extension/connection`, {
      headers: { origin: extensionOrigin, authorization: `Bearer ${polled.credential}` },
    })
    assert.equal(connection.pairing.extensionId, extensionId)
    assert.equal(Object.hasOwn(connection.pairing, 'credential'), false)
    assert.equal(Object.hasOwn(connection.pairing, 'credentialHash'), false)

    const sessionId = 'extension-session:evidenceboundary1234'
    const page = {
      tabId: 7,
      origin: 'https://example.com',
      url: 'https://example.com/form',
      title: 'Evidence form',
      documentId: 'document-11111111-1111-4111-8111-111111111111',
      documentRevision: 1,
    }
    const observation = {
      protocol: 'tokenless.harness-browser-extension/v2',
      kind: 'semantic_page_observation',
      page: { ...page, tabId: undefined },
      observationRevision: 1,
      controls: [{
        elementRef: 'element-22222222-2222-4222-8222-222222222222',
        role: 'textbox',
        name: 'Answer',
        label: 'Answer',
        placeholder: '',
        inputType: 'textarea',
        valuePresence: 'empty',
        actions: ['input'],
        visible: true,
        enabled: true,
        editable: true,
        structuralHint: 'form / field 1',
        contextText: 'Answer',
      }],
    }
    delete observation.page.tabId
    await jsonFetch(`${daemon.origin}/v1/harness/browser-extension/sessions`, {
      method: 'POST',
      headers: { ...extensionHeaders, authorization: `Bearer ${polled.credential}` },
      body: JSON.stringify({
        sessionId,
        page,
        observation,
        evidence: {
          rawDom: '<html><body><textarea>full evidence</textarea></body></html>',
          screenshotDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
          capturedAt: '2026-08-28T00:00:00.000Z',
        },
      }),
    }, 201)
    const evidenceDir = path.join(homeDir, 'harness-browser-extension-evidence', 'extension-session_evidenceboundary1234')
    assert.match(fs.readFileSync(path.join(evidenceDir, 'page.html'), 'utf8'), /full evidence/)
    assert.equal(JSON.parse(fs.readFileSync(path.join(evidenceDir, 'session.json'), 'utf8')).extensionCredential, polled.credential)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(evidenceDir, 'page.html')).mode & 0o777, 0o600)
      assert.equal(fs.statSync(path.join(evidenceDir, 'session.json')).mode & 0o777, 0o600)
    }
    await jsonFetch(`${daemon.origin}/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: { ...extensionHeaders, authorization: `Bearer ${polled.credential}` },
    })

    const daemonControl = await fetch(`${daemon.origin}/v1/private/control/state`, {
      headers: { origin: extensionOrigin, authorization: `Bearer ${polled.credential}` },
    })
    assert.equal(daemonControl.status, 403)

    const revoked = await jsonFetch(
      `${daemon.origin}/dashboard-api/v1/harness/browser-extension/pairings/${encodeURIComponent(created.pairingId)}/revoke`,
      { method: 'POST', headers: mutationHeaders, body: '{}' },
    )
    assert.equal(revoked.status, 'revoked')
    const rejected = await fetch(`${daemon.origin}/v1/harness/browser-extension/connection`, {
      headers: { origin: extensionOrigin, authorization: `Bearer ${polled.credential}` },
    })
    assert.equal(rejected.status, 403)
  } finally {
    await daemon.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function jsonFetch(url, init = undefined, expectedStatus = 200) {
  const response = await fetch(url, init)
  const body = await response.json()
  assert.equal(response.status, expectedStatus, JSON.stringify(body))
  return body
}
