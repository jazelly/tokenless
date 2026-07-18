import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  VISIBLE_ACTIONS,
  createProviderAdapterRegistry,
  createVisibleActionRequest,
  listProviders,
} from '../packages/playwright/dist/src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(root, 'test/fixtures/provider-dom')

const providers = [
  {
    id: 'chatgpt',
    state: 'signed-in-paid',
    url: 'https://chatgpt.com/',
  },
  {
    id: 'claude',
    state: 'signed-in-free',
    url: 'https://claude.ai/new',
  },
  {
    id: 'gemini',
    state: 'signed-in-unknown',
    url: 'https://gemini.google.com/app',
  },
  {
    id: 'grok',
    state: 'signed-in-unknown',
    url: 'https://grok.com/',
  },
]

test('blocker.check classifies visible challenge families, sign-in, terminal blockers, and ignores hidden matches', { timeout: 60000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  t.after(() => browser.close())

  const cases = [
    ['recaptcha', '<iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" style="width:300px;height:80px"></iframe>', 'visible_recaptcha', 'challenge'],
    ['cloudflare', '<main style="display:block">Checking if the site connection is secure. Verify you are human.</main>', 'visible_cloudflare_interstitial', 'challenge'],
    ['turnstile', '<iframe title="Cloudflare Turnstile" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/managed/v1" style="width:300px;height:80px"></iframe>', 'visible_cloudflare_turnstile', 'challenge'],
    ['hcaptcha', '<iframe title="hCaptcha" src="https://newassets.hcaptcha.com/captcha/v1/test" style="width:300px;height:80px"></iframe>', 'visible_hcaptcha', 'challenge'],
    ['arkose', '<iframe title="FunCaptcha" src="https://client-api.arkoselabs.com/fc/gc/" style="width:300px;height:80px"></iframe>', 'visible_arkose_funcaptcha', 'challenge'],
    ['sign-in', '<button style="display:block;width:200px;height:40px">Sign in</button>', 'provider_sign_in_visible', 'auth'],
    ['placeholder-sign-in', '<input placeholder="Email address" style="display:block;width:260px;height:40px">', 'provider_sign_in_visible', 'auth'],
    ['rate-limit', '<main style="display:block">Rate limit reached. Too many requests.</main>', 'provider_rate_limited', 'terminal'],
    ['plan-limit', '<main style="display:block">Upgrade your plan to continue.</main>', 'provider_plan_limited', 'terminal'],
  ]

  for (const [name, body, code, kind] of cases) {
    await t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
      const page = await context.newPage()
      try {
        await fulfillProviderPage(page, `<!doctype html><html><body>${body}<textarea style="width:400px;height:80px"></textarea></body></html>`)
        const response = await registry.execute(
          page,
          visibleRequest('chatgpt', VISIBLE_ACTIONS.BLOCKER_CHECK),
          { profileId: 'profile', operationId: `blocker-${name}` },
        )
        assert.equal(response.ok, true, JSON.stringify(response, null, 2))
        assert.equal(response.result.blocked, true)
        assert.equal(response.result.blockers.some((blocker) => blocker.code === code && blocker.kind === kind), true)
      } finally {
        await context.close()
      }
    })
  }

  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  const page = await context.newPage()
  try {
    await fulfillProviderPage(page, '<!doctype html><html><body><iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor" style="display:none;width:300px;height:80px"></iframe><main>Ready</main></body></html>')
    const startedAt = performance.now()
    const response = await registry.execute(
      page,
      visibleRequest('chatgpt', VISIBLE_ACTIONS.BLOCKER_CHECK),
      { profileId: 'profile', operationId: 'blocker-hidden' },
    )
    const elapsedMs = performance.now() - startedAt
    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(response.result.blocked, false)
    assert.equal(response.result.blockers.length, 0)
    assert.ok(elapsedMs < 250, `no-blocker check took ${elapsedMs}ms`)
  } finally {
    await context.close()
  }

  for (const [name, body] of [
    ['hidden-ancestor-text', '<div style="opacity:0"><main style="display:block;width:300px;height:80px">Checking if the site connection is secure. Verify you are human.</main></div>'],
    ['hidden-placeholder-sign-in', '<div style="opacity:0"><input placeholder="Email address" style="display:block;width:260px;height:40px"></div>'],
    ['generic-data-sitekey', '<div data-sitekey="recaptcha-site-key" style="display:block;width:260px;height:80px"></div>'],
  ]) {
    await t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
      const page = await context.newPage()
      try {
        await fulfillProviderPage(page, `<!doctype html><html><body>${body}<textarea style="width:400px;height:80px"></textarea></body></html>`)
        const response = await registry.execute(
          page,
          visibleRequest('chatgpt', VISIBLE_ACTIONS.BLOCKER_CHECK),
          { profileId: 'profile', operationId: `blocker-${name}` },
        )
        assert.equal(response.ok, true, JSON.stringify(response, null, 2))
        assert.equal(response.result.blocked, false)
        assert.equal(response.result.blockers.length, 0)
      } finally {
        await context.close()
      }
    })
  }

  for (const [name, provider, url, body] of [
    ['hidden-login-selector-fallback', 'claude', 'https://claude.ai/new', '<div style="opacity:0"><input placeholder="Enter your email" style="display:block;width:260px;height:40px"></div>'],
    ['hidden-captcha-selector-fallback', 'chatgpt', 'https://chatgpt.com/', '<div style="opacity:0"><iframe title="captcha" src="https://example.com/captcha" style="width:300px;height:80px"></iframe></div>'],
    ['hidden-rate-selector-fallback', 'chatgpt', 'https://chatgpt.com/', '<div style="opacity:0;width:300px;height:80px">Rate limit reached. Too many requests.</div>'],
  ]) {
    await t.test(name, async () => {
      const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
      const page = await context.newPage()
      try {
        await fulfillProviderPage(page, `<!doctype html><html><body>${body}<textarea style="width:400px;height:80px"></textarea></body></html>`, url)
        const response = await registry.execute(
          page,
          visibleRequest(provider, VISIBLE_ACTIONS.BLOCKER_CHECK),
          { profileId: 'profile', operationId: `blocker-${name}` },
        )
        assert.equal(response.ok, true, JSON.stringify(response, null, 2))
        assert.equal(response.result.blocked, false)
        assert.equal(response.result.blockers.length, 0)
      } finally {
        await context.close()
      }
    })
  }
})

test('public Playwright provider registry inputs and clears prompt text on captured composer DOM', { timeout: 60000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  const providerConfigs = new Map(listProviders().map((provider) => [provider.id, provider]))
  t.after(() => browser.close())

  assert.deepEqual(providers.map((provider) => provider.id), ['chatgpt', 'claude', 'gemini', 'grok'])

  for (const provider of providers) {
    await t.test(provider.id, async () => {
      const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
      const page = await context.newPage()
      try {
        await openCapturedFixture(page, provider)
        const providerConfig = providerConfigs.get(provider.id)
        assert.ok(providerConfig, `provider config missing: ${provider.id}`)
        const prompt = `Tokenless deterministic prompt draft for ${provider.id}`
        const adapterContext = {
          profileId: `${provider.id}-fixture-profile`,
          operationId: `${provider.id}-prompt-actions`,
        }

        const input = await registry.execute(page, visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_INPUT, { text: prompt }), adapterContext)
        assert.equal(input.ok, true, JSON.stringify(input, null, 2))
        assert.deepEqual(input.result, {
          visible: true,
          inputProof: 'prompt-text-visible',
        })
        assert.equal(await visibleComposerText(page, providerConfig.composerSelectors), prompt)

        const clear = await registry.execute(page, visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_CLEAR), adapterContext)
        assert.equal(clear.ok, true, JSON.stringify(clear, null, 2))
        assert.deepEqual(clear.result, {
          visible: true,
          inputProof: 'empty',
        })
        assert.equal(await visibleComposerText(page, providerConfig.composerSelectors), '')
      } finally {
        await context.close()
      }
    })
  }
})

async function fulfillProviderPage(page, body, url = 'https://chatgpt.com/') {
  const origin = new URL(url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body,
  }))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
}

test('public Playwright provider registry fails text-free when prompt text is not visible', { timeout: 30000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  t.after(() => browser.close())

  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    const provider = providers[0]
    const providerConfig = listProviders().find((candidate) => candidate.id === provider.id)
    assert.ok(providerConfig, `provider config missing: ${provider.id}`)
    await openCapturedFixture(page, provider)
    const composer = page.locator(providerConfig.composerSelectors[0]).first()
    await composer.evaluate((element) => {
      element.addEventListener('input', () => {
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          element.value = ''
        } else {
          element.textContent = ''
        }
      })
    })

    const marker = 'Tokenless deterministic nonvisible prompt draft'
    const response = await registry.execute(
      page,
      visibleRequest(provider.id, VISIBLE_ACTIONS.PROMPT_INPUT, { text: marker }),
      {
        profileId: `${provider.id}-fixture-profile`,
        operationId: `${provider.id}-prompt-actions-nonvisible`,
      },
    )

    assert.equal(response.ok, false, JSON.stringify(response, null, 2))
    assert.equal(response.result, null)
    assert.equal(response.error?.code, 'playwright_unexpected_error')
    assert.doesNotMatch(JSON.stringify(response), new RegExp(marker))
    assert.equal(await visibleComposerText(page, providerConfig.composerSelectors), '')
  } finally {
    await context.close()
  }
})

test('public Playwright provider registry targets the visible composer when a hidden fallback matches first', { timeout: 30000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  t.after(() => browser.close())

  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><textarea hidden></textarea><textarea aria-label="Chat with ChatGPT"></textarea></body></html>',
    }))
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })

    const marker = 'Tokenless visible composer selection proof'
    const response = await registry.execute(
      page,
      visibleRequest('chatgpt', VISIBLE_ACTIONS.PROMPT_INPUT, { text: marker }),
      { profileId: 'chatgpt-fixture-profile', operationId: 'chatgpt-visible-composer' },
    )

    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(await page.locator('textarea').nth(0).inputValue(), '')
    assert.equal(await page.locator('textarea').nth(1).inputValue(), marker)
  } finally {
    await context.close()
  }
})

test('public Playwright provider registry retries when hydration replaces the visible composer', { timeout: 60000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  t.after(() => browser.close())

  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    await page.route('https://chatgpt.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><textarea aria-label="Loading composer"></textarea></body></html>',
    }))
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
    await page.locator('textarea').evaluate((element) => {
      element.addEventListener('input', () => {
        const composer = document.createElement('div')
        composer.id = 'prompt-textarea'
        composer.contentEditable = 'true'
        composer.setAttribute('role', 'textbox')
        composer.style.cssText = 'display:block;width:600px;height:48px'
        element.replaceWith(composer)
      }, { once: true })
    })

    const marker = 'Tokenless hydrated composer retry proof'
    const response = await registry.execute(
      page,
      visibleRequest('chatgpt', VISIBLE_ACTIONS.PROMPT_INPUT, { text: marker }),
      { profileId: 'chatgpt-fixture-profile', operationId: 'chatgpt-hydrated-composer' },
    )

    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(await page.locator('#prompt-textarea').textContent(), marker)
  } finally {
    await context.close()
  }
})

test('public Playwright provider registry waits until a hydrating composer retains input', { timeout: 30000 }, async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const registry = createProviderAdapterRegistry()
  t.after(() => browser.close())

  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } })
  const page = await context.newPage()
  try {
    await page.route('https://claude.ai/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div data-testid="chat-input" contenteditable="true" role="textbox" style="width:600px;height:48px"></div></body></html>',
    }))
    await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded' })
    await page.locator('[data-testid="chat-input"]').evaluate((element) => {
      const readyAt = Date.now() + 2200
      element.addEventListener('input', () => {
        if (Date.now() < readyAt) element.textContent = ''
      })
    })

    const marker = 'Tokenless delayed hydration proof'
    const started = Date.now()
    const response = await registry.execute(
      page,
      visibleRequest('claude', VISIBLE_ACTIONS.PROMPT_INPUT, { text: marker }),
      { profileId: 'claude-fixture-profile', operationId: 'claude-delayed-hydration' },
    )

    assert.equal(response.ok, true, JSON.stringify(response, null, 2))
    assert.equal(Date.now() - started >= 7500, true)
    assert.equal(await page.locator('[data-testid="chat-input"]').textContent(), marker)
  } finally {
    await context.close()
  }
})

async function openCapturedFixture(page, provider) {
  const origin = new URL(provider.url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: composerFixture(provider),
  }))
  await page.goto(provider.url, { waitUntil: 'domcontentloaded' })
}

function composerFixture(provider) {
  const filename = path.join(fixtureRoot, provider.id, provider.state, 'composer-idle.html')
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
          if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value
          return (element.textContent ?? '').replace(/\u00a0/g, ' ').trim()
        })
      }
    } catch {
      // Try the next configured composer selector.
    }
  }
  throw new Error('No visible composer was found.')
}
