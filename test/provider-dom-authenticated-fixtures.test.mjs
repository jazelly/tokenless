import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureRoot = path.join(root, 'test', 'fixtures', 'provider-dom')
const scenarios = Object.freeze([
  'session-status',
  'model-menu-open',
  'thinking-effort-menu-open',
  'file-input-ready',
  'composer-idle',
])
const deepWorkflowMinimums = Object.freeze({
  chatgpt: 7,
  claude: 6,
  gemini: 7,
  grok: 9,
})
const providers = Object.freeze({
  chatgpt: {
    accountState: 'signed-in-paid',
    plan: { status: 'observed', label: 'Plus' },
    sanitizedUrl: 'https://chatgpt.com/',
  },
  claude: {
    accountState: 'signed-in-free',
    plan: { status: 'observed', label: 'Free' },
    sanitizedUrl: 'https://claude.ai/new',
  },
  gemini: {
    accountState: 'signed-in-unknown',
    plan: { status: 'unknown', label: null },
    sanitizedUrl: 'https://gemini.google.com/app',
  },
  grok: {
    accountState: 'signed-in-unknown',
    plan: { status: 'unknown', label: null },
    sanitizedUrl: 'https://grok.com/',
  },
})
const adapterSelectorAudit = Object.freeze({
  chatgpt: {
    'session-status': [
      ['[data-testid="accounts-profile-button"][role="button"]', 1],
    ],
    'model-menu-open': [
      ['main div#prompt-textarea[contenteditable="true"]', 1],
      ['main button.__composer-pill[aria-expanded][aria-haspopup="menu"]', 1],
      ['[role="menuitem"][aria-haspopup="menu"]', 1],
      ['div[role="menu"] + div[role="menu"] [role="menuitemradio"]', 5],
    ],
    'thinking-effort-menu-open': [
      ['main div#prompt-textarea[contenteditable="true"]', 1],
      ['main button.__composer-pill[aria-expanded][aria-haspopup="menu"]', 1],
      ['[role="menu"] [role="menuitemradio"]', 3],
    ],
    'file-input-ready': [
      ['div#prompt-textarea[contenteditable="true"]', 1],
      ['button[data-testid="composer-plus-btn"][aria-label="Add files and more"]', 1],
      ['input#upload-files[type="file"][multiple]', 1],
    ],
    'composer-idle': [['div#prompt-textarea[contenteditable="true"]', 1]],
  },
  claude: {
    'session-status': [['button[data-testid="user-menu-button"]', 1]],
    'model-menu-open': [
      ['button[data-testid="model-selector-dropdown"][aria-label^="Model: "]', 1],
      ['[role="menu"] [role="menuitemradio"]', 4],
    ],
    'thinking-effort-menu-open': [
      ['button[data-testid="model-selector-dropdown"][aria-label^="Model: "]', 1],
      ['[role="menuitem"][aria-haspopup="menu"]', 1],
      ['button[role="switch"][aria-label="Thinking"]', 1],
      ['div[role="menu"] + div[role="menu"] [role="menuitemradio"]', 5],
    ],
    'file-input-ready': [
      ['div[data-testid="chat-input"][contenteditable="true"][role="textbox"]', 1],
      ['input#chat-input-file-upload-onpage[data-testid="file-upload"][aria-label="Upload files"][type="file"][multiple]', 1],
    ],
    'composer-idle': [['div[data-testid="chat-input"][contenteditable="true"][role="textbox"]', 1]],
  },
  gemini: {
    'session-status': [['a[href*="accounts.google.com/SignOutOptions"]', 1]],
    'model-menu-open': [
      ['button[data-test-id="bard-mode-menu-button"][aria-haspopup]', 1],
      ['gem-menu-item[role="menuitem"][data-mode-id] .label', 3],
      ['gem-menu-item-content.selected', 1],
    ],
    'thinking-effort-menu-open': [
      ['gem-menu-item[role="menuitem"]:not([data-mode-id]) .label', 1],
      ['gem-menu-item-content.selected', 1],
    ],
    'file-input-ready': [
      ['rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]', 1],
      ['button[aria-label="Upload and tools"]', 1],
      ['button[role="menuitem"][data-test-id="local-images-files-uploader-button"][aria-label^="Upload files"]', 1],
      ['input[type="file"][name="Filedata"][multiple]', 1],
    ],
    'composer-idle': [['rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]', 1]],
  },
  grok: {
    'session-status': [['button:has(img[alt="pfp"])', 1]],
    'model-menu-open': [
      ['button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]', 1],
      ['[role="menuitem"][data-radix-collection-item] span.font-semibold', 4],
      ['[role="menuitem"] button', 1],
    ],
    'thinking-effort-menu-open': [
      ['[role="menuitem"][data-radix-collection-item] span.font-semibold', 2],
      ['[role="menuitem"] button', 1],
    ],
    'file-input-ready': [
      ['div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]', 1],
      ['button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]', 1],
      ['input[type="file"][name="files"][multiple]', 1],
    ],
    'composer-idle': [['div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]', 1]],
  },
})

test('authenticated provider DOM fixtures retain only redacted, provenance-bound visible evidence', {
  timeout: 30000,
}, async () => {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    for (const [provider, expected] of Object.entries(providers)) {
      const accountRoot = path.join(fixtureRoot, provider, expected.accountState)
      const retainedScenarios = new Set(
        (await fs.readdir(accountRoot))
          .filter((name) => name.endsWith('.html'))
          .map((name) => name.replace(/\.html$/, ''))
      )
      for (const scenario of scenarios) {
        assert.equal(retainedScenarios.has(scenario), true, `${provider} retains ${scenario}`)
      }

      for (const scenario of scenarios) {
        const htmlPath = path.join(accountRoot, `${scenario}.html`)
        const provenancePath = path.join(accountRoot, `${scenario}.provenance.json`)
        const [htmlBytes, provenanceText] = await Promise.all([
          fs.readFile(htmlPath),
          fs.readFile(provenancePath, 'utf8'),
        ])
        const html = htmlBytes.toString('utf8')
        const provenance = JSON.parse(provenanceText)

        assert.equal(provenance.schema, 'tokenless.provider-dom-provenance.v1')
        assert.equal(provenance.provider, provider)
        assert.equal(provenance.accountState, expected.accountState)
        assert.deepEqual(provenance.observedPlan, expected.plan)
        assert.equal(provenance.scenario, scenario)
        assert.equal(provenance.routeClass, 'new-chat')
        assert.equal(provenance.observedOn, '2026-07-17')
        assert.equal(provenance.sanitizedUrl, expected.sanitizedUrl)
        assert.equal(provenance.source, 'authenticated-user-visible-chrome-session')
        assert.equal(provenance.artifactKind, 'redacted-reduced-dom')
        assert.equal(provenance.containsProviderJavaScript, false)
        assert.equal(provenance.containsSyntheticBehavior, false)
        assert.deepEqual(provenance.redactions.includes('scripts'), true)
        assert.deepEqual(provenance.redactions.includes('styles'), true)
        assert.match(provenance.contentSha256, /^[a-f0-9]{64}$/)
        assert.equal(sha256(htmlBytes), provenance.contentSha256, `${provider}/${scenario} hash`)

        for (const artifact of [html, provenanceText]) assertPrivacyBoundary(artifact)
        assert.doesNotMatch(html, /<script\b/i)
        assert.doesNotMatch(html, /<style\b/i)

        await page.setContent(html)
        for (const evidence of provenance.evidenceSelectors) {
          assert.equal(
            await page.locator(evidence.selector).count(),
            evidence.expectedCount,
            `${provider}/${scenario} ${evidence.capability}: ${evidence.selector}`
          )
        }
        for (const absence of provenance.absenceSelectors) {
          assert.equal(
            await page.locator(absence.selector).count(),
            absence.expectedCount,
            `${provider}/${scenario} ${absence.purpose}: ${absence.selector}`
          )
        }
        for (const [selector, expectedCount] of adapterSelectorAudit[provider][scenario]) {
          assert.equal(
            await page.locator(selector).count(),
            expectedCount,
            `${provider}/${scenario} adapter selector: ${selector}`
          )
        }
        await assertSanitizedLinks(page, `${provider}/${scenario}`)
      }
    }
  } finally {
    await browser.close()
  }
})

test('provider DOM manifest inventories every fixture with its sanitized page URL', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'tokenless.provider-dom-manifest.v2')
  assert.equal(manifest.generatedBy, 'test/helpers/build-provider-workflow-fixtures.mjs')
  assert.equal(Array.isArray(manifest.fixtures), true)

  const listed = new Set()
  for (const entry of manifest.fixtures) {
    const provenance = JSON.parse(await fs.readFile(
      path.join(fixtureRoot, entry.provenancePath),
      'utf8'
    ))
    await fs.access(path.join(fixtureRoot, entry.htmlPath))
    assert.equal(provenance.provider, entry.provider)
    assert.equal(provenance.accountState, entry.accountState)
    assert.equal(provenance.scenario, entry.scenario)
    assert.equal(provenance.routeClass, entry.routeClass)
    assert.equal(typeof entry.operationPhase, 'string')
    assert.match(entry.capabilityOutcome, /^(?:available|unavailable|unknown)$/)
    if (provenance.operationPhase !== undefined) {
      assert.equal(provenance.operationPhase, entry.operationPhase)
      assert.equal(provenance.capabilityOutcome, entry.capabilityOutcome)
    }
    assert.equal(provenance.sanitizedUrl, entry.sanitizedUrl)
    assert.equal(provenance.observedOn, entry.observedOn)
    listed.add(entry.htmlPath)
  }

  const actual = new Set()
  for (const provider of Object.keys(providers)) {
    const accountStates = await fs.readdir(path.join(fixtureRoot, provider), { withFileTypes: true })
    for (const accountState of accountStates.filter((entry) => entry.isDirectory())) {
      const files = await fs.readdir(path.join(fixtureRoot, provider, accountState.name))
      for (const file of files.filter((name) => name.endsWith('.html'))) {
        actual.add(path.join(provider, accountState.name, file))
      }
    }
  }
  assert.deepEqual([...listed].sort(), [...actual].sort())
})

test('deep workflow fixtures cover authenticated provider jobs, settings, connectors, uploads, and media', {
  timeout: 30000,
}, async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'))
  const deepEntries = manifest.fixtures.filter((entry) => entry.observedOn === '2026-07-25')
  const counts = Object.fromEntries(Object.keys(deepWorkflowMinimums).map((provider) => [provider, 0]))
  const routeClasses = Object.fromEntries(Object.keys(deepWorkflowMinimums).map((provider) => [provider, new Set()]))
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  try {
    for (const entry of deepEntries) {
      const [htmlBytes, provenanceText] = await Promise.all([
        fs.readFile(path.join(fixtureRoot, entry.htmlPath)),
        fs.readFile(path.join(fixtureRoot, entry.provenancePath), 'utf8'),
      ])
      const html = htmlBytes.toString('utf8')
      const provenance = JSON.parse(provenanceText)
      counts[entry.provider] += 1
      routeClasses[entry.provider].add(entry.routeClass)

      assert.equal(provenance.source, 'authenticated-user-visible-chrome-session')
      assert.equal(provenance.artifactKind, 'redacted-reduced-dom')
      assert.equal(provenance.containsProviderJavaScript, false)
      assert.equal(provenance.containsSyntheticBehavior, false)
      if (provenance.operationPhase !== undefined) {
        assert.equal(provenance.operationPhase, entry.operationPhase)
        assert.equal(provenance.capabilityOutcome, entry.capabilityOutcome)
      }
      assert.equal(sha256(htmlBytes), provenance.contentSha256)
      assertPrivacyBoundary(html)
      assertPrivacyBoundary(provenanceText)
      assert.doesNotMatch(html, /<script\b|<style\b/i)

      await page.setContent(html)
      for (const evidence of provenance.evidenceSelectors) {
        assert.equal(
          await page.locator(evidence.selector).count(),
          evidence.expectedCount,
          `${entry.provider}/${entry.scenario} ${evidence.capability}: ${evidence.selector}`
        )
      }
      for (const expectedAbsence of provenance.absenceSelectors) {
        assert.equal(
          await page.locator(expectedAbsence.selector).count(),
          expectedAbsence.expectedCount,
          `${entry.provider}/${entry.scenario} ${expectedAbsence.purpose}: ${expectedAbsence.selector}`
        )
      }
      await assertSanitizedLinks(page, `${entry.provider}/${entry.scenario}`)
    }
  } finally {
    await browser.close()
  }

  for (const [provider, minimum] of Object.entries(deepWorkflowMinimums)) {
    assert.equal(counts[provider] >= minimum, true, `${provider} deep fixture count`)
    assert.equal(routeClasses[provider].size >= 4, true, `${provider} distinct route classes`)
  }
})

test('current Grok Free fixture preserves the visible model entitlement boundary', async () => {
  const accountRoot = path.join(fixtureRoot, 'grok', 'signed-in-free')
  const [htmlBytes, provenanceText] = await Promise.all([
    fs.readFile(path.join(accountRoot, 'model-menu-open.html')),
    fs.readFile(path.join(accountRoot, 'model-menu-open.provenance.json'), 'utf8'),
  ])
  const html = htmlBytes.toString('utf8')
  const provenance = JSON.parse(provenanceText)

  assert.equal(provenance.observedOn, '2026-07-25')
  assert.equal(provenance.sanitizedUrl, 'https://grok.com/')
  assert.deepEqual(provenance.observedPlan, { status: 'observed', label: 'Free' })
  assert.equal(sha256(htmlBytes), provenance.contentSha256)
  assertPrivacyBoundary(html)
  assertPrivacyBoundary(provenanceText)

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.setContent(html)
    assert.equal(
      await page.locator('[role="menuitem"][data-radix-collection-item].text-secondary.opacity-75 span.font-semibold').count(),
      3
    )
    assert.deepEqual(
      await page.locator('[role="menuitem"][data-radix-collection-item].text-secondary.opacity-75 span.font-semibold').allTextContents(),
      ['Auto', 'Expert', 'Heavy']
    )
    assert.equal(
      await page.locator('[role="menuitem"][data-radix-collection-item][disabled], [role="menuitem"][data-radix-collection-item][aria-disabled="true"], [role="menuitem"][data-radix-collection-item][data-disabled]').count(),
      0
    )
    assert.equal(await page.getByRole('button', { name: 'Upgrade' }).count(), 1)
  } finally {
    await browser.close()
  }
})

test('provider-specific selection semantics and plan uncertainty remain explicit', async () => {
  const geminiRoot = path.join(fixtureRoot, 'gemini', 'signed-in-unknown')
  const grokRoot = path.join(fixtureRoot, 'grok', 'signed-in-unknown')
  const claudeRoot = path.join(fixtureRoot, 'claude', 'signed-in-free')
  const chatgptRoot = path.join(fixtureRoot, 'chatgpt', 'signed-in-paid')

  const [geminiHtml, grokModelHtml, grokEffort, claudeModelHtml, chatgptEffortHtml] = await Promise.all([
    fs.readFile(path.join(geminiRoot, 'model-menu-open.html'), 'utf8'),
    fs.readFile(path.join(grokRoot, 'model-menu-open.html'), 'utf8'),
    readProvenance(grokRoot, 'thinking-effort-menu-open'),
    fs.readFile(path.join(claudeRoot, 'model-menu-open.html'), 'utf8'),
    fs.readFile(path.join(chatgptRoot, 'thinking-effort-menu-open.html'), 'utf8'),
  ])

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.setContent(geminiHtml)
    assert.equal(
      await page.locator('gem-menu-item[data-active="true"] gem-menu-item-content').innerText(),
      '3.1 Flash-Lite'
    )
    assert.equal(
      await page.locator('gem-menu-item[data-mode-id="pro"] gem-menu-item-content.selected').innerText(),
      '3.1 ProSelected'
    )

    await page.setContent(grokModelHtml)
    assert.deepEqual(
      await page.locator('[role="menuitem"][data-radix-collection-item][aria-disabled="false"] .font-semibold').allTextContents(),
      ['Fast', 'Auto', 'Expert', 'Heavy']
    )
    assert.equal(await page.getByRole('button', { name: 'Upgrade' }).count(), 1)

    await page.setContent(claudeModelHtml)
    assert.equal(
      await page.getByRole('menuitemradio').filter({ hasText: 'Fable 5' }).filter({ hasText: 'Upgrade' }).count(),
      1
    )

    await page.setContent(chatgptEffortHtml)
    assert.equal(await page.getByRole('menuitemradio').count(), 3)
  } finally {
    await browser.close()
  }

  assert.equal(grokEffort.effortMode, 'coupled-to-model')

  const geminiSession = await readProvenance(geminiRoot, 'session-status')
  const grokSession = await readProvenance(grokRoot, 'session-status')
  assert.deepEqual(geminiSession.observedPlan, { status: 'unknown', label: null })
  assert.deepEqual(grokSession.observedPlan, { status: 'unknown', label: null })
})

async function readProvenance(accountRoot, scenario) {
  return JSON.parse(await fs.readFile(
    path.join(accountRoot, `${scenario}.provenance.json`),
    'utf8'
  ))
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertPrivacyBoundary(artifact) {
  assert.doesNotMatch(artifact, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  assert.doesNotMatch(artifact, /\b(?:cookie|localStorage|sessionStorage|authorization)\b/i)
  assert.doesNotMatch(artifact, /\/(?:c|chat)\/[A-Za-z0-9_-]{6,}/)
  assert.doesNotMatch(artifact, /(?:access|refresh|id)[_-]?token/i)
}

async function assertSanitizedLinks(page, fixtureLabel) {
  const hrefs = await page.locator('[href]').evaluateAll((nodes) => (
    nodes.map((node) => node.getAttribute('href'))
  ))
  for (const href of hrefs) {
    assert.equal(href.includes('?'), false, `${fixtureLabel} href query removed`)
    assert.equal(href.includes('#'), false, `${fixtureLabel} href fragment removed`)
    assert.doesNotMatch(href, /\/(?:c|chat)\/[A-Za-z0-9_-]+/, `${fixtureLabel} private route removed`)
  }
}
