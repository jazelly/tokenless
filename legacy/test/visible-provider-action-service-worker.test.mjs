import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDist = path.join(root, 'packages', 'extension', 'dist', 'extension')
const ACTION_MODULE = '../legacy/extension/dist/extension/shared/visible-provider-actions.js'

test('service worker exposes the v1 runtime route only to extension-owned pages', async () => {
  const previousChrome = globalThis.chrome
  const runtimeMessage = chromeEvent()
  const createdTabs = []
  const providerMessages = []
  let nextTabId = 1

  const nativePort = {
    onMessage: chromeEvent(),
    onDisconnect: chromeEvent(),
    posted: [],
    postMessage(message) {
      this.posted.push(message)
    },
    disconnect() {},
  }

  globalThis.chrome = {
    runtime: {
      id: 'tokenless-test-extension',
      lastError: undefined,
      onInstalled: chromeEvent(),
      onStartup: chromeEvent(),
      onMessage: runtimeMessage,
      connectNative(name) {
        assert.equal(name, 'dev.tokenless.native_host')
        return nativePort
      },
      async sendMessage() {
        throw new Error('debugger companion is outside this test')
      },
    },
    sidePanel: {
      async setPanelBehavior() {},
    },
    scripting: {
      async executeScript() {
        throw new Error('content script should already be present')
      },
    },
    tabs: {
      async query() {
        return []
      },
      async create(details) {
        const tab = {
          id: nextTabId++,
          windowId: 1,
          active: details.active === true,
          status: 'complete',
          url: String(details.url),
        }
        createdTabs.push(tab)
        return tab
      },
      async get(tabId) {
        return createdTabs.find((tab) => tab.id === tabId)
      },
      async update(tabId, details) {
        const tab = createdTabs.find((candidate) => candidate.id === tabId)
        Object.assign(tab, details)
        return tab
      },
      async sendMessage(tabId, message) {
        providerMessages.push({ tabId, message })
        if (message.type === 'tokenless.bridge.inspect_auth') {
          return {
            status: 'inspected',
            provider: 'gemini',
            visible: true,
            auth: { state: 'unauthenticated' },
          }
        }
        if (message.type === 'tokenless.bridge.validate_landing') return { status: 'ready' }
        if (message.type === 'tokenless.bridge.inspect_controls') {
          return {
            status: 'inspected',
            controls: {
              models: [{ label: 'Flash', selected: true, available: true }],
              efforts: [],
            },
          }
        }
        throw new Error(`Unexpected provider message: ${message.type}`)
      },
    },
    windows: {
      async update() {},
    },
  }

  try {
    const serviceWorkerUrl = pathToFileURL(path.join(extensionDist, 'background', 'service-worker.js'))
    serviceWorkerUrl.searchParams.set('visible-provider-runtime', String(Date.now()))
    await import(serviceWorkerUrl.href)
    await nativePort.onMessage.emit({
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_connected',
      ok: true,
      result: {
        status: 'connected',
        sessionId: 'visible-provider-runtime-test',
      },
    })
    assert.equal(runtimeMessage.listeners.length, 1)

    const actions = await import(ACTION_MODULE)
    const envelope = actions.createVisibleProviderRuntimeEnvelope(actions.createVisibleProviderActionRequest({
      requestId: 'service-worker-model-inspect',
      provider: 'gemini',
      action: actions.VISIBLE_PROVIDER_ACTIONS.MODEL_INSPECT,
      payload: {},
    }))

    const untrusted = await invokeListener(runtimeMessage.listeners[0], envelope, {
      id: 'tokenless-test-extension',
      tab: { id: 99, url: 'https://gemini.google.com/app' },
      url: 'https://gemini.google.com/app',
    })
    assert.equal(untrusted.ok, false)
    assert.equal(untrusted.error.code, 'visible_action_sender_rejected')
    assert.deepEqual(createdTabs, [], 'provider content scripts must not trigger tab creation')

    const response = await invokeListener(runtimeMessage.listeners[0], envelope, {
      id: 'tokenless-test-extension',
      url: 'chrome-extension://tokenless-test-extension/settings/index.html',
    })
    assert.equal(response.ok, true)
    assert.deepEqual(response.result, {
      choices: [{ label: 'Flash', selected: true, enabled: true }],
    })
    assert.deepEqual(createdTabs.map(({ url }) => url), ['https://gemini.google.com/app'])
    assert.deepEqual(providerMessages.map(({ message }) => message.type), [
      'tokenless.bridge.inspect_auth',
      'tokenless.bridge.validate_landing',
      'tokenless.bridge.inspect_controls',
    ])
    assert.deepEqual(nativePort.posted, [{
      protocol: 'tokenless.native.v1',
      type: 'tokenless.native.daemon_connect',
    }])
  } finally {
    globalThis.chrome = previousChrome
  }
})

function chromeEvent() {
  const listeners = []
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener)
    },
    async emit(message) {
      for (const listener of listeners) await listener(message)
    },
  }
}

function invokeListener(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('runtime listener timed out')), 5000)
    const sendResponse = (response) => {
      clearTimeout(timeout)
      resolve(response)
    }
    try {
      const asynchronous = listener(message, sender, sendResponse)
      if (asynchronous !== true && asynchronous !== false && asynchronous !== undefined) {
        clearTimeout(timeout)
        reject(new Error('runtime listener returned an invalid keepalive value'))
      }
    } catch (error) {
      clearTimeout(timeout)
      reject(error)
    }
  })
}
