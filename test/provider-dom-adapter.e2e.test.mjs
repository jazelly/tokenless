import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const contentScript = path.join(root, 'packages/extension/dist/extension/content/provider-content.js')
const fixtureRoot = path.join(root, 'test/fixtures/provider-dom')

const providers = [
  {
    id: 'chatgpt',
    state: 'signed-in-paid',
    url: 'https://chatgpt.com/',
    model: 'GPT-5.6 Sol',
    composer: '#prompt-textarea',
    auth: { state: 'authenticated', plan: { label: 'Plus', free: false } },
  },
  {
    id: 'claude',
    state: 'signed-in-free',
    url: 'https://claude.ai/new',
    model: 'Haiku 4.5',
    composer: '[data-testid="chat-input"]',
    auth: { state: 'authenticated', plan: { label: 'Free', free: true } },
  },
  {
    id: 'gemini',
    state: 'signed-in-unknown',
    url: 'https://gemini.google.com/app',
    model: '3.1 Pro',
    composer: 'rich-textarea [role="textbox"]',
    auth: { state: 'authenticated' },
  },
  {
    id: 'grok',
    state: 'signed-in-unknown',
    url: 'https://grok.com/',
    model: 'Fast',
    composer: '[role="textbox"][aria-label="Ask Grok anything"]',
    auth: { state: 'authenticated' },
  },
]

test('captured authenticated DOM drives priority auth, model, and prompt adapter actions', { timeout: 60000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  for (const provider of providers) {
    await t.test(provider.id, async () => {
      const modelSession = await openCapturedFixture(browser, provider, ['session-status', 'model-menu-open'])
      try {
        const auth = await dispatch(modelSession.page, {
          type: 'tokenless.bridge.inspect_auth',
          request: { provider: provider.id, requestId: `${provider.id}-captured-auth` },
        })
        assert.deepEqual(auth.auth, provider.auth)
        assert.doesNotMatch(JSON.stringify(auth), /redacted account identity/i)

        const inventory = await dispatch(modelSession.page, {
          type: 'tokenless.bridge.inspect_controls',
          request: { provider: provider.id, requestId: `${provider.id}-captured-model-inspect` },
        })
        const capturedModel = inventory.controls.models.find((choice) => choice.label === provider.model)
        assert.deepEqual(capturedModel, {
          label: provider.model,
          selected: true,
          available: true,
        })

        const configured = await dispatch(modelSession.page, {
          type: 'tokenless.bridge.configure_controls',
          request: {
            provider: provider.id,
            requestId: `${provider.id}-captured-model-select`,
            model: provider.model.toLocaleLowerCase('en-US'),
          },
        })
        assert.equal(configured.status, 'configured')
        assert.equal(configured.model.applied, provider.model)
        assert.deepEqual(modelSession.pageErrors, [])
      } finally {
        await modelSession.context.close()
      }

      const promptSession = await openCapturedFixture(browser, provider, ['session-status', 'composer-idle'])
      try {
        const prompt = `Captured DOM prompt proof for ${provider.id}`
        const input = await dispatch(promptSession.page, {
          type: 'tokenless.bridge.input_prompt',
          request: {
            provider: provider.id,
            requestId: `${provider.id}-captured-prompt-input`,
            prompt,
            mode: 'replace',
          },
        })
        assert.equal(input.status, 'input')
        assert.equal(input.visible, true)
        assert.equal(await promptSession.page.locator(provider.composer).first().evaluate((node) => (
          'value' in node && typeof node.value === 'string' && node.value.length > 0
            ? node.value
            : node.innerText
        )), prompt)
        assert.deepEqual(promptSession.pageErrors, [])
      } finally {
        await promptSession.context.close()
      }
    })
  }
})

async function openCapturedFixture(browser, provider, scenarios) {
  const html = mergedFixture(provider, scenarios)
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  await context.addInitScript(() => {
    const listeners = []
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          onMessage: { addListener(listener) { listeners.push(listener) } },
        },
      },
    })
    Object.defineProperty(globalThis, '__dispatchTokenlessMessage', {
      configurable: true,
      value(message) {
        return new Promise((resolve, reject) => {
          const listener = listeners[0]
          if (!listener) return reject(new Error('Provider content listener is not installed.'))
          let responded = false
          const keepOpen = listener(message, {}, (response) => {
            responded = true
            resolve(response)
          })
          if (keepOpen !== true && !responded) reject(new Error('Provider content response channel closed.'))
        })
      },
    })
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const origin = new URL(provider.url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: html,
  }))
  await page.goto(provider.url, { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: contentScript })
  return { context, page, pageErrors }
}

function mergedFixture(provider, scenarios) {
  const bodies = scenarios.map((scenario) => {
    const filename = path.join(fixtureRoot, provider.id, provider.state, `${scenario}.html`)
    const match = fs.readFileSync(filename, 'utf8').match(/<body[^>]*>([\s\S]*?)<\/body>/iu)
    assert.ok(match, `fixture body missing: ${filename}`)
    return match[1]
  })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${bodies.join('\n')}</body></html>`
}

function dispatch(page, message) {
  return page.evaluate((payload) => globalThis.__dispatchTokenlessMessage(payload), message)
}
