import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

import {
  VISIBLE_ACTIONS,
  createVisibleActionRequest,
  getProviderInstanceById,
} from '../packages/cli/dist/src/playwright/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(root, 'test/fixtures/provider-dom')
const providers = [
  {
    id: 'chatgpt',
    state: 'signed-in-paid',
    url: 'https://chatgpt.com/',
    composerSelectors: [
      'div#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
    ],
  },
  {
    id: 'claude',
    state: 'signed-in-free',
    url: 'https://claude.ai/new',
    composerSelectors: [
      'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]',
    ],
  },
  {
    id: 'gemini',
    state: 'signed-in-unknown',
    url: 'https://gemini.google.com/app',
    composerSelectors: [
      'rich-textarea div.ql-editor[contenteditable="true"][role="textbox"]',
    ],
  },
  {
    id: 'grok',
    state: 'signed-in-unknown',
    url: 'https://grok.com/',
    composerSelectors: [
      'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"]',
    ],
  },
  {
    id: 'qwen',
    state: 'signed-out-guest',
    scenario: 'studio-response-complete',
    url: 'https://chat.qwen.ai/',
    composerSelectors: [
      'textarea.message-input-textarea',
    ],
  },
  {
    id: 'dola',
    state: 'signed-in-unknown',
    scenario: 'response-complete',
    url: 'https://www.dola.com/chat',
    composerSelectors: [
      'textarea.semi-input-textarea[placeholder="Message..."]',
    ],
  },
]

test('real Chromium inputs and clears drafts on provenance-bound provider DOM captures', {
  timeout: 60000,
}, async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  for (const provider of providers) {
    await t.test(provider.id, async () => {
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
      const page = await context.newPage()
      try {
        await openCapturedFixture(page, provider, provider.scenario)
        const providerInstance = getProviderInstanceById(provider.id)
        assert.ok(providerInstance, `provider instance missing: ${provider.id}`)
        const prompt = `Tokenless deterministic prompt draft for ${provider.id}`
        const adapterContext = {
          profileId: `${provider.id}-fixture-profile`,
          operationId: `${provider.id}-prompt-actions`,
        }

        const input = await providerInstance.executeAction(
          page,
          visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_INPUT, { text: prompt }),
          adapterContext,
        )
        assert.equal(input.ok, true, JSON.stringify(input, null, 2))
        assert.deepEqual(input.result, {
          visible: true,
          inputProof: 'prompt-text-visible',
        })
        assert.equal(await visibleComposerText(page, provider.composerSelectors), prompt)

        const clear = await providerInstance.executeAction(
          page,
          visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_CLEAR),
          adapterContext,
        )
        assert.equal(clear.ok, true, JSON.stringify(clear, null, 2))
        assert.deepEqual(clear.result, {
          visible: true,
          inputProof: 'empty',
        })
        assert.equal(await visibleComposerText(page, provider.composerSelectors), '')
      } finally {
        await context.close()
      }
    })
  }
})

test('prompt input reports a visibility timeout when the captured provider page has no composer', {
  timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    const provider = providers[0]
    assert.ok(provider)
    await openCapturedFixture(page, provider, 'settings-general')

    const startedAt = Date.now()
    const providerInstance = getProviderInstanceById(provider.id)
    assert.ok(providerInstance, `provider instance missing: ${provider.id}`)
    const input = await providerInstance.executeAction(
      page,
      visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_INPUT, { text: 'Tokenless timeout probe' }),
      {
        profileId: `${provider.id}-fixture-profile`,
        operationId: `${provider.id}-prompt-input-timeout`,
      },
    )
    const elapsedMs = Date.now() - startedAt

    assert.equal(input.ok, false)
    assert.deepEqual(input.error, {
      code: 'prompt_input_visibility_timeout',
      message: 'Timed out after 15000ms waiting for a visible prompt input.',
      retryable: true,
    })
    assert.ok(elapsedMs >= 14000, `prompt input returned before the visibility timeout: ${elapsedMs}ms`)
    assert.ok(elapsedMs < 20000, `prompt input exceeded the bounded visibility timeout: ${elapsedMs}ms`)
  } finally {
    await context.close()
    await browser.close()
  }
})

test('prompt submit reports an actionability timeout when the captured provider page has no enabled submit control', {
  timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    const provider = providers[0]
    assert.ok(provider)
    await openCapturedFixture(page, provider, 'settings-general')

    const startedAt = Date.now()
    const providerInstance = getProviderInstanceById(provider.id)
    assert.ok(providerInstance, `provider instance missing: ${provider.id}`)
    const submit = await providerInstance.executeAction(
      page,
      visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_SUBMIT),
      {
        profileId: `${provider.id}-fixture-profile`,
        operationId: `${provider.id}-prompt-submit-timeout`,
      },
    )
    const elapsedMs = Date.now() - startedAt

    assert.equal(submit.ok, false)
    assert.deepEqual(submit.error, {
      code: 'prompt_submit_actionability_timeout',
      message: 'Timed out after 15000ms waiting for an enabled visible prompt submit control.',
      retryable: true,
    })
    assert.ok(elapsedMs >= 14000, `prompt submit returned before the actionability timeout: ${elapsedMs}ms`)
    assert.ok(elapsedMs < 20000, `prompt submit exceeded the bounded actionability timeout: ${elapsedMs}ms`)
  } finally {
    await context.close()
    await browser.close()
  }
})

async function openCapturedFixture(page, provider, scenario = 'composer-idle') {
  const origin = new URL(provider.url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: capturedFixture(provider, scenario),
  }))
  await page.goto(provider.url, { waitUntil: 'domcontentloaded' })
}

function capturedFixture(provider, scenario) {
  const filename = path.join(fixtureRoot, provider.id, provider.state, `${scenario}.html`)
  const match = fs.readFileSync(filename, 'utf8').match(/<body[^>]*>([\s\S]*?)<\/body>/iu)
  assert.ok(match, `fixture body missing: ${filename}`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${match[1]}</body></html>`
}

function visibleRequest(provider, action, payload = {}) {
  return createVisibleActionRequest({
    requestId: `${provider}-${action.replaceAll('.', '-')}`,
    provider,
    action,
    payload,
  })
}

async function visibleComposerText(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    try {
      if (await locator.isVisible({ timeout: 250 })) {
        return await locator.evaluate((element) => {
          if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
            return element.value
          }
          return (element.textContent ?? '').replace(/\u00a0/g, ' ').trim()
        })
      }
    } catch {
      // Try the next configured composer selector.
    }
  }
  throw new Error('No visible composer was found.')
}
