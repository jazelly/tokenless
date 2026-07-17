import assert from 'node:assert/strict'
import test from 'node:test'

const BRIDGE_MODULE = '../packages/extension/dist/extension/shared/bridge-protocol.js'
const ACTION_MODULE = '../packages/extension/dist/extension/shared/visible-provider-actions.js'

const descriptor = Object.freeze({
  protocol: 'tokenless.visible-attachment.v1',
  bundleId: 'native-route-bundle',
  attachmentId: 'native-route-file',
  name: 'evidence.txt',
  type: 'text/plain',
  size: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
})

test('bridge accepts one strict nested v1 action and correlates its wrapper', async () => {
  const bridge = await import(BRIDGE_MODULE)
  const actions = await import(ACTION_MODULE)
  const visibleAction = actions.createVisibleProviderActionRequest({
    requestId: 'native-route-model',
    provider: 'gemini',
    action: actions.VISIBLE_PROVIDER_ACTIONS.MODEL_SELECT,
    payload: { label: '3.1 Pro' },
  })
  const request = bridge.createBridgeRequest({
    requestId: visibleAction.requestId,
    provider: visibleAction.provider,
    action: bridge.BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION,
    visibleAction,
  })
  const validation = bridge.validateBridgeRequest(request)
  assert.equal(validation.ok, true)
  assert.deepEqual(validation.request.visibleAction, visibleAction)
  assert.ok(bridge.capabilitiesPayload().actions.includes('visible_provider_action'))
})

test('bridge rejects nested identity drift, unknown wrapper fields, and non-v1 shapes', async () => {
  const bridge = await import(BRIDGE_MODULE)
  const actions = await import(ACTION_MODULE)
  const visibleAction = actions.createVisibleProviderActionRequest({
    requestId: 'native-route-auth',
    provider: 'claude',
    action: actions.VISIBLE_PROVIDER_ACTIONS.AUTH_STATUS,
    payload: {},
  })
  const base = bridge.createBridgeRequest({
    requestId: visibleAction.requestId,
    provider: visibleAction.provider,
    action: bridge.BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION,
    visibleAction,
  })

  assert.equal(bridge.validateBridgeRequest({ ...base, requestId: 'wrapper-drift' }).error.code, 'visible_action_bridge_mismatch')
  assert.equal(bridge.validateBridgeRequest({ ...base, provider: 'gemini' }).error.code, 'visible_action_bridge_mismatch')
  assert.equal(bridge.validateBridgeRequest({ ...base, prompt: 'must-not-cross-wrapper' }).error.code, 'invalid_visible_action_bridge_shape')
  assert.equal(bridge.validateBridgeRequest({
    ...base,
    visibleAction: { ...visibleAction, privateToken: 'must-not-be-accepted' },
  }).error.code, 'invalid_visible_action_request')
})

test('standalone file upload requires path-free native descriptors to match nested payload exactly', async () => {
  const bridge = await import(BRIDGE_MODULE)
  const actions = await import(ACTION_MODULE)
  const visibleAction = actions.createVisibleProviderActionRequest({
    requestId: 'native-route-file',
    provider: 'chatgpt',
    action: actions.VISIBLE_PROVIDER_ACTIONS.FILE_UPLOAD,
    payload: { attachments: [descriptor] },
  })
  const base = bridge.createBridgeRequest({
    requestId: visibleAction.requestId,
    provider: visibleAction.provider,
    action: bridge.BRIDGE_ACTIONS.VISIBLE_PROVIDER_ACTION,
    visibleAction,
    attachments: [descriptor],
  })
  assert.equal(bridge.validateBridgeRequest(base).ok, true)

  const mismatched = structuredClone(base)
  mismatched.attachments = [{ ...mismatched.attachments[0], name: 'different.txt' }]
  assert.equal(bridge.validateBridgeRequest(mismatched).error.code, 'visible_action_attachment_mismatch')
  assert.equal(bridge.validateBridgeRequest({ ...base, attachments: undefined }).error.code, 'visible_action_attachment_mismatch')
  assert.doesNotMatch(JSON.stringify(base), /sourcePath|stagedPath|^[A-Za-z]:\\|cookie|localStorage|sessionStorage/i)
})
