import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { chromium } from 'playwright'
import {
  captureProviderDom,
  disconnectFromCdp,
  PROVIDER_DEFINITIONS,
} from './capture-provider-dom-cdp.mjs'

const PRIVATE_MARKER = 'TOKENLESS_PRIVATE_ATTRIBUTE_MARKER_7f41d9'
const EXACT_GROUPS = ['composers', 'submits', 'answers', 'fileInputs', 'projectLinks']
const GEMINI_SELECTOR_INDEXES = Object.freeze({
  composers: [0],
  submits: [0],
  answers: [0, 1],
  busy: [0],
  modelPickers: [0],
  fileInputs: [0, 1],
  projectLinks: [0],
})
const GROK_SELECTOR_INDEXES = Object.freeze({
  composers: [0, 1],
  submits: [0],
  answers: [0],
  blockers: [0],
  modelPickers: [0],
  fileInputs: [0, 1],
})
const captureCdpE2eEnabled = process.env.TOKENLESS_CAPTURE_CDP_E2E === '1'

test('capture sanitizer preserves provider selectors without retaining arbitrary attribute values', {
  skip: captureCdpE2eEnabled ? false : 'set TOKENLESS_CAPTURE_CDP_E2E=1 to run the external-CDP helper test',
  timeout: 120000,
}, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-capture-sanitizer-'))
  const port = await availablePort()
  const endpoint = `http://127.0.0.1:${port}`
  const chrome = spawn(chromium.executablePath(), [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${path.join(tempRoot, 'profile')}`,
    '--disable-background-networking',
    '--no-default-browser-check',
    '--no-first-run',
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })

  let browser
  try {
    await waitForCdp(endpoint, chrome)
    browser = await chromium.connectOverCDP(endpoint)
    const context = browser.contexts()[0]
    await context.route('https://claude.ai/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: secretBearingClaudeFixture(),
    }))
    const providerPage = context.pages()[0] ?? await context.newPage()
    await providerPage.goto('https://claude.ai/new')
    disconnectFromCdp(browser)
    browser = undefined

    const savedArgv = process.argv
    process.argv = [
      'node',
      'capture-provider-dom-cdp.mjs',
      '--provider',
      'claude',
      '--cdp-url',
      endpoint,
      '--output-dir',
      path.join(tempRoot, 'captures'),
    ]
    let result
    try {
      result = await captureProviderDom()
    } finally {
      process.argv = savedArgv
    }

    assert.equal(result.ok, true)
    const metadata = JSON.parse(await fs.readFile(result.metadataPath, 'utf8'))
    const probes = JSON.parse(await fs.readFile(result.selectorProbesPath, 'utf8'))
    const html = await fs.readFile(result.htmlPath, 'utf8')
    assert.equal(metadata.provider, 'claude')
    assert.equal(metadata.surface, 'visible-session-web-ui')
    assert.equal(html.includes(PRIVATE_MARKER), false)
    for (const group of EXACT_GROUPS) assert.equal(probes[group][0].count, 1, group)

    browser = await chromium.connectOverCDP(endpoint)
    const validationPage = await browser.contexts()[0].newPage()
    await validationPage.setContent(html)
    for (const group of EXACT_GROUPS) {
      assert.equal(
        await validationPage.locator(PROVIDER_DEFINITIONS.claude.selectors[group][0]).count(),
        1,
        `${group} exact selector`
      )
    }

    const arbitraryAttributes = await validationPage.locator('section').evaluate((node) => (
      Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value]))
    ))
    assert.deepEqual(arbitraryAttributes, {})

    const composer = validationPage.locator(PROVIDER_DEFINITIONS.claude.selectors.composers[0])
    assert.equal(await composer.getAttribute('id'), null)
    assert.equal(await composer.getAttribute('class'), 'ProseMirror')
    assert.equal(await composer.getAttribute('name'), null)
    assert.equal(await composer.getAttribute('aria-controls'), null)
    assert.equal(await composer.getAttribute('aria-description'), null)
    assert.equal(await composer.getAttribute('data-private'), null)
    assert.equal(await composer.getAttribute('aria-label'), 'Write your prompt to Claude')

    const fileInput = validationPage.locator(PROVIDER_DEFINITIONS.claude.selectors.fileInputs[0])
    assert.equal(await fileInput.getAttribute('id'), 'chat-input-file-upload-onpage')
    assert.equal(await fileInput.getAttribute('class'), null)
    assert.equal(await fileInput.getAttribute('name'), null)
    assert.equal(await fileInput.getAttribute('aria-label'), null)

    const projectLink = validationPage.locator(PROVIDER_DEFINITIONS.claude.selectors.projectLinks[0])
    assert.equal(await projectLink.getAttribute('href'), '/projects')
    assert.equal(await projectLink.getAttribute('aria-label'), 'Projects')
    assert.equal(await projectLink.getAttribute('id'), null)
    assert.equal(await projectLink.getAttribute('class'), null)

    const broadSend = validationPage.locator('button').filter({ hasText: '[text]' }).last()
    assert.equal((await broadSend.getAttribute('aria-label'))?.includes('Send'), true)
    assert.equal((await broadSend.getAttribute('aria-label'))?.includes(PRIVATE_MARKER), false)
    await validationPage.close()

    process.argv = [
      'node',
      'capture-provider-dom-cdp.mjs',
      '--provider',
      'claude',
      '--cdp-url',
      endpoint,
      '--output-dir',
      path.join(tempRoot, 'bounded-text-captures'),
      '--include-text',
      '--max-text-chars',
      '24',
    ]
    let boundedResult
    try {
      boundedResult = await captureProviderDom()
    } finally {
      process.argv = savedArgv
    }
    assert.equal(boundedResult.ok, true)
    const boundedHtml = await fs.readFile(boundedResult.htmlPath, 'utf8')
    const boundedVisibleText = await fs.readFile(boundedResult.visibleTextPath, 'utf8')
    const boundedMetadataText = await fs.readFile(boundedResult.metadataPath, 'utf8')
    const boundedProbesText = await fs.readFile(boundedResult.selectorProbesPath, 'utf8')
    const boundedMetadata = JSON.parse(boundedMetadataText)
    const boundedProbes = JSON.parse(boundedProbesText)
    assert.ok(boundedVisibleText.trimEnd().length <= 24)
    assert.ok(boundedMetadata.title.length <= 24)
    for (const probes of Object.values(boundedProbes)) {
      for (const probe of probes) assert.ok(probe.firstText.length <= 24)
    }
    for (const artifact of [
      boundedHtml,
      boundedVisibleText,
      boundedMetadataText,
      boundedProbesText,
    ]) {
      assert.equal(artifact.includes(PRIVATE_MARKER), false)
    }

    const boundedPage = await browser.contexts()[0].newPage()
    await boundedPage.setContent(boundedHtml)
    const preservedDomTextLength = await boundedPage.evaluate(() => {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT)
      let length = 0
      while (walker.nextNode()) {
        const value = walker.currentNode.nodeValue?.trim() || ''
        if (value && value !== '[text]') length += value.length
      }
      return length
    })
    assert.ok(preservedDomTextLength <= 24)
    await boundedPage.close()

    const geminiContext = browser.contexts()[0]
    await geminiContext.route('https://gemini.google.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: secretBearingGeminiFixture(),
    }))
    const geminiProviderPage = await geminiContext.newPage()
    await geminiProviderPage.goto('https://gemini.google.com/app')
    await geminiProviderPage.evaluate((privateMarker) => {
      history.replaceState(null, '', `/app/${privateMarker}`)
    }, PRIVATE_MARKER)
    disconnectFromCdp(browser)
    browser = undefined

    process.argv = [
      'node',
      'capture-provider-dom-cdp.mjs',
      '--provider',
      'gemini',
      '--cdp-url',
      endpoint,
      '--output-dir',
      path.join(tempRoot, 'gemini-captures'),
    ]
    let geminiResult
    try {
      geminiResult = await captureProviderDom()
    } finally {
      process.argv = savedArgv
    }

    assert.equal(geminiResult.ok, true)
    const geminiMetadataText = await fs.readFile(geminiResult.metadataPath, 'utf8')
    const geminiProbesText = await fs.readFile(geminiResult.selectorProbesPath, 'utf8')
    const geminiHtml = await fs.readFile(geminiResult.htmlPath, 'utf8')
    const geminiMetadata = JSON.parse(geminiMetadataText)
    const geminiProbes = JSON.parse(geminiProbesText)
    assert.equal(geminiMetadata.provider, 'gemini')
    assert.equal(geminiMetadata.surface, 'visible-session-web-ui')
    assert.equal(geminiMetadata.url, 'https://gemini.google.com/app/[redacted]')
    assert.equal(geminiResult.url, geminiMetadata.url)
    for (const artifact of [geminiHtml, geminiMetadataText, geminiProbesText]) {
      assert.equal(artifact.includes(PRIVATE_MARKER), false)
    }
    for (const [group, indexes] of Object.entries(GEMINI_SELECTOR_INDEXES)) {
      for (const index of indexes) {
        assert.equal(geminiProbes[group][index].count, 1, `${group}[${index}] probe`)
      }
    }

    browser = await chromium.connectOverCDP(endpoint)
    const geminiValidationPage = await browser.contexts()[0].newPage()
    await geminiValidationPage.setContent(geminiHtml)
    for (const [group, indexes] of Object.entries(GEMINI_SELECTOR_INDEXES)) {
      for (const index of indexes) {
        const selector = PROVIDER_DEFINITIONS.gemini.selectors[group][index]
        assert.equal(
          await geminiValidationPage.locator(selector).count(),
          1,
          `${group}[${index}] exact selector`
        )
      }
    }

    const geminiArbitraryAttributes = await geminiValidationPage.locator('section').evaluate((node) => (
      Object.fromEntries([...node.attributes].map((attribute) => [attribute.name, attribute.value]))
    ))
    assert.deepEqual(geminiArbitraryAttributes, {})

    const geminiComposer = geminiValidationPage.locator(
      PROVIDER_DEFINITIONS.gemini.selectors.composers[0]
    )
    assert.equal(await geminiComposer.getAttribute('class'), 'ql-editor')
    assert.equal(await geminiComposer.getAttribute('data-gramm'), 'false')
    assert.equal(await geminiComposer.getAttribute('aria-label'), 'Enter a prompt for Gemini')
    assert.equal(await geminiComposer.getAttribute('id'), null)
    assert.equal(await geminiComposer.getAttribute('name'), null)
    assert.equal(await geminiComposer.getAttribute('aria-controls'), null)
    assert.equal(await geminiComposer.getAttribute('data-private'), null)

    const geminiAnswer = geminiValidationPage.locator(
      PROVIDER_DEFINITIONS.gemini.selectors.answers[0]
    )
    assert.equal(await geminiAnswer.textContent(), '[text]')
    assert.equal(await geminiAnswer.getAttribute('id'), null)
    assert.equal(await geminiAnswer.getAttribute('class'), null)
    assert.equal(await geminiAnswer.getAttribute('data-private'), null)

    const modelPicker = geminiValidationPage.locator(
      PROVIDER_DEFINITIONS.gemini.selectors.modelPickers[0]
    )
    assert.equal(await modelPicker.getAttribute('data-test-id'), 'bard-mode-menu-button')
    assert.equal(
      await modelPicker.getAttribute('aria-label'),
      'Open mode picker, currently [text]'
    )
    assert.equal(await modelPicker.getAttribute('data-private'), null)

    const localUploader = geminiValidationPage.locator(
      PROVIDER_DEFINITIONS.gemini.selectors.fileInputs[1]
    )
    assert.equal(
      await localUploader.getAttribute('aria-label'),
      'Upload files. Documents, data, code files'
    )
    assert.equal(await localUploader.getAttribute('data-private'), null)

    const gemsLink = geminiValidationPage.locator(
      PROVIDER_DEFINITIONS.gemini.selectors.projectLinks[0]
    )
    assert.equal(await gemsLink.getAttribute('href'), '/gems/view')
    assert.equal(await gemsLink.getAttribute('id'), null)
    assert.equal(await gemsLink.getAttribute('data-private'), null)
    await geminiValidationPage.close()

    const grokContext = browser.contexts()[0]
    await grokContext.route('https://grok.com/**', (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: secretBearingGrokFixture(),
    }))
    const grokProviderPage = await grokContext.newPage()
    await grokProviderPage.goto('https://grok.com/')
    await grokProviderPage.evaluate((privateMarker) => {
      history.replaceState(null, '', `/c/${privateMarker}`)
    }, PRIVATE_MARKER)
    disconnectFromCdp(browser)
    browser = undefined

    process.argv = [
      'node',
      'capture-provider-dom-cdp.mjs',
      '--provider',
      'grok',
      '--cdp-url',
      endpoint,
      '--output-dir',
      path.join(tempRoot, 'grok-captures'),
    ]
    let grokResult
    try {
      grokResult = await captureProviderDom()
    } finally {
      process.argv = savedArgv
    }

    assert.equal(grokResult.ok, true)
    const grokMetadataText = await fs.readFile(grokResult.metadataPath, 'utf8')
    const grokProbesText = await fs.readFile(grokResult.selectorProbesPath, 'utf8')
    const grokHtml = await fs.readFile(grokResult.htmlPath, 'utf8')
    const grokMetadata = JSON.parse(grokMetadataText)
    const grokProbes = JSON.parse(grokProbesText)
    assert.equal(grokMetadata.provider, 'grok')
    assert.equal(grokMetadata.surface, 'visible-session-web-ui')
    assert.equal(grokMetadata.url, 'https://grok.com/c/[redacted]')
    assert.equal(grokResult.url, grokMetadata.url)
    for (const artifact of [grokHtml, grokMetadataText, grokProbesText]) {
      assert.equal(artifact.includes(PRIVATE_MARKER), false)
    }
    for (const [group, indexes] of Object.entries(GROK_SELECTOR_INDEXES)) {
      for (const index of indexes) {
        assert.equal(grokProbes[group][index].count, 1, `${group}[${index}] probe`)
      }
    }

    browser = await chromium.connectOverCDP(endpoint)
    const grokValidationPage = await browser.contexts()[0].newPage()
    await grokValidationPage.setContent(grokHtml)
    for (const [group, indexes] of Object.entries(GROK_SELECTOR_INDEXES)) {
      for (const index of indexes) {
        const selector = PROVIDER_DEFINITIONS.grok.selectors[group][index]
        assert.equal(
          await grokValidationPage.locator(selector).count(),
          1,
          `${group}[${index}] exact selector`
        )
      }
    }

    const grokComposer = grokValidationPage.locator(
      PROVIDER_DEFINITIONS.grok.selectors.composers[0]
    )
    assert.equal(await grokComposer.getAttribute('class'), 'tiptap ProseMirror')
    assert.equal(await grokComposer.getAttribute('aria-label'), 'Ask Grok anything')
    assert.equal(await grokComposer.getAttribute('aria-multiline'), 'true')
    assert.equal(await grokComposer.getAttribute('id'), null)
    assert.equal(await grokComposer.getAttribute('data-private'), null)

    const grokFileInput = grokValidationPage.locator(
      PROVIDER_DEFINITIONS.grok.selectors.fileInputs[0]
    )
    assert.equal(await grokFileInput.getAttribute('name'), 'files')
    assert.equal(await grokFileInput.getAttribute('multiple'), '')
    assert.equal(await grokFileInput.getAttribute('class'), null)
    assert.equal(await grokFileInput.getAttribute('data-private'), null)

    const grokAnswer = grokValidationPage.locator(
      PROVIDER_DEFINITIONS.grok.selectors.answers[0]
    )
    assert.equal(await grokAnswer.textContent(), '[text]')
    assert.equal(await grokAnswer.getAttribute('id'), null)
    assert.equal(await grokAnswer.getAttribute('data-private'), null)
    await grokValidationPage.close()
  } finally {
    disconnectFromCdp(browser)
    await stopControlledChrome(endpoint, chrome)
    const resolvedTempRoot = path.resolve(tempRoot)
    assert.equal(
      path.dirname(resolvedTempRoot).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
      'Refusing to remove an unexpected directory.'
    )
    await fs.rm(resolvedTempRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }
})

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForCdp(endpoint, chrome) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (chrome.exitCode !== null) throw new Error('Controlled Chrome exited before CDP was ready.')
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return
    } catch {
      // The dedicated local endpoint may not be listening yet.
    }
    await delay(50)
  }
  throw new Error('Controlled Chrome did not expose CDP in time.')
}

async function stopControlledChrome(endpoint, chrome) {
  let cleanupBrowser
  try {
    cleanupBrowser = await chromium.connectOverCDP(endpoint, { timeout: 2000 })
    const session = await cleanupBrowser.newBrowserCDPSession()
    await Promise.race([
      session.send('Browser.close').catch(() => undefined),
      delay(2000),
    ])
  } catch {
    // The controlled process may already be gone after a failed assertion.
  } finally {
    disconnectFromCdp(cleanupBrowser)
  }
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), delay(3000)])
  if (chrome.exitCode === null) chrome.kill('SIGTERM')
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), delay(3000)])
  if (chrome.exitCode === null) chrome.kill('SIGKILL')
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), delay(3000)])
}

function secretBearingClaudeFixture() {
  return `<!doctype html>
<html
  id="${PRIVATE_MARKER}-html-id"
  class="${PRIVATE_MARKER}-html-class"
  name="${PRIVATE_MARKER}-html-name"
  aria-label="${PRIVATE_MARKER}-html-aria"
  data-private="${PRIVATE_MARKER}-html-data"
>
  <head><title>${PRIVATE_MARKER} title</title></head>
  <body>
    <section
      id="${PRIVATE_MARKER}-id"
      class="${PRIVATE_MARKER}-class"
      name="${PRIVATE_MARKER}-name"
      aria-label="${PRIVATE_MARKER}-aria-label"
      aria-controls="${PRIVATE_MARKER}-aria-controls"
      aria-valuetext="${PRIVATE_MARKER}-aria-value"
      data-testid="${PRIVATE_MARKER}-testid"
      data-private="${PRIVATE_MARKER}-data"
      custom-attribute="${PRIVATE_MARKER}-custom"
    >${PRIVATE_MARKER} arbitrary text</section>
    <main>
      <div data-testid="virtual-message-list" aria-live="polite">
        <div
          class="font-claude-response-body ${PRIVATE_MARKER}-answer-class"
          id="${PRIVATE_MARKER}-answer-id"
          name="${PRIVATE_MARKER}-answer-name"
          aria-label="${PRIVATE_MARKER}-answer-aria"
          data-private="${PRIVATE_MARKER}-answer-data"
        >${PRIVATE_MARKER} answer text</div>
      </div>
      <input
        id="chat-input-file-upload-onpage"
        data-testid="file-upload"
        type="file"
        hidden
        class="${PRIVATE_MARKER}-file-class"
        name="${PRIVATE_MARKER}-file-name"
        aria-label="${PRIVATE_MARKER}-file-aria"
      >
      <div
        data-testid="chat-input"
        contenteditable="true"
        role="textbox"
        class="ProseMirror ${PRIVATE_MARKER}-composer-class"
        id="${PRIVATE_MARKER}-composer-id"
        name="${PRIVATE_MARKER}-composer-name"
        aria-label="Write your prompt to Claude"
        aria-controls="${PRIVATE_MARKER}-composer-controls"
        aria-description="${PRIVATE_MARKER}-composer-description"
        data-private="${PRIVATE_MARKER}-composer-data"
      ><p>${PRIVATE_MARKER} prompt text</p></div>
      <button
        data-cds="Button"
        aria-label="Send message"
        type="button"
        class="${PRIVATE_MARKER}-send-class"
        name="${PRIVATE_MARKER}-send-name"
      >${PRIVATE_MARKER} send text</button>
      <button
        aria-label="Send ${PRIVATE_MARKER}-broad-label"
        class="${PRIVATE_MARKER}-broad-send-class"
      >${PRIVATE_MARKER} broad send text</button>
      <a
        href="/projects"
        aria-label="Projects"
        id="${PRIVATE_MARKER}-project-id"
        class="${PRIVATE_MARKER}-project-class"
        name="${PRIVATE_MARKER}-project-name"
        data-private="${PRIVATE_MARKER}-project-data"
      >${PRIVATE_MARKER} projects text</a>
    </main>
  </body>
</html>`
}

function secretBearingGeminiFixture() {
  return `<!doctype html>
<html
  id="${PRIVATE_MARKER}-html-id"
  class="${PRIVATE_MARKER}-html-class"
  aria-label="${PRIVATE_MARKER}-html-aria"
  data-private="${PRIVATE_MARKER}-html-data"
>
  <head><title>${PRIVATE_MARKER} Gemini title</title></head>
  <body>
    <section
      id="${PRIVATE_MARKER}-id"
      class="${PRIVATE_MARKER}-class"
      name="${PRIVATE_MARKER}-name"
      aria-label="${PRIVATE_MARKER}-aria-label"
      aria-controls="${PRIVATE_MARKER}-aria-controls"
      data-test-id="${PRIVATE_MARKER}-testid"
      data-private="${PRIVATE_MARKER}-data"
      custom-attribute="${PRIVATE_MARKER}-custom"
    >${PRIVATE_MARKER} arbitrary Gemini text</section>
    <nav>
      <a
        href="/gems/view"
        id="${PRIVATE_MARKER}-gems-id"
        class="${PRIVATE_MARKER}-gems-class"
        data-private="${PRIVATE_MARKER}-gems-data"
      >${PRIVATE_MARKER} Gems text</a>
    </nav>
    <main>
      <response-container
        id="${PRIVATE_MARKER}-response-id"
        data-private="${PRIVATE_MARKER}-response-data"
      >
        <structured-content-container
          class="message-content ${PRIVATE_MARKER}-structured-class"
          aria-label="${PRIVATE_MARKER}-structured-aria"
          data-private="${PRIVATE_MARKER}-structured-data"
        >
          <message-content
            id="${PRIVATE_MARKER}-message-id"
            class="${PRIVATE_MARKER}-message-class"
            data-private="${PRIVATE_MARKER}-message-data"
          >${PRIVATE_MARKER} answer text</message-content>
        </structured-content-container>
      </response-container>
      <rich-textarea data-private="${PRIVATE_MARKER}-rich-textarea-data">
        <div
          class="ql-editor ${PRIVATE_MARKER}-composer-class"
          data-gramm="false"
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="Enter a prompt for Gemini"
          id="${PRIVATE_MARKER}-composer-id"
          name="${PRIVATE_MARKER}-composer-name"
          aria-controls="${PRIVATE_MARKER}-composer-controls"
          data-private="${PRIVATE_MARKER}-composer-data"
        ><p>${PRIVATE_MARKER} prompt text</p></div>
      </rich-textarea>
      <button
        aria-label="Send message"
        type="button"
        class="${PRIVATE_MARKER}-send-class"
        data-private="${PRIVATE_MARKER}-send-data"
      >${PRIVATE_MARKER} send text</button>
      <button
        aria-label="Stop response"
        type="button"
        class="${PRIVATE_MARKER}-stop-class"
        data-private="${PRIVATE_MARKER}-stop-data"
      >${PRIVATE_MARKER} stop text</button>
      <button
        data-test-id="bard-mode-menu-button"
        aria-label="Open mode picker, currently Flash ${PRIVATE_MARKER}"
        type="button"
        class="${PRIVATE_MARKER}-model-class"
        data-private="${PRIVATE_MARKER}-model-data"
      >${PRIVATE_MARKER} model text</button>
      <button
        aria-label="Upload &amp; tools"
        aria-haspopup="menu"
        type="button"
        class="${PRIVATE_MARKER}-tools-class"
        data-private="${PRIVATE_MARKER}-tools-data"
      >${PRIVATE_MARKER} tools text</button>
      <button
        data-test-id="local-images-files-uploader-button"
        role="menuitem"
        aria-label="Upload files. Documents, data, code files"
        type="button"
        class="${PRIVATE_MARKER}-upload-class"
        data-private="${PRIVATE_MARKER}-upload-data"
      >${PRIVATE_MARKER} upload text</button>
    </main>
  </body>
</html>`
}

function secretBearingGrokFixture() {
  return `<!doctype html>
<html
  id="${PRIVATE_MARKER}-html-id"
  class="${PRIVATE_MARKER}-html-class"
  aria-label="${PRIVATE_MARKER}-html-aria"
  data-private="${PRIVATE_MARKER}-html-data"
>
  <head><title>${PRIVATE_MARKER} Grok title</title></head>
  <body>
    <section
      id="${PRIVATE_MARKER}-id"
      class="${PRIVATE_MARKER}-class"
      name="${PRIVATE_MARKER}-name"
      aria-label="${PRIVATE_MARKER}-aria-label"
      data-testid="${PRIVATE_MARKER}-testid"
      data-private="${PRIVATE_MARKER}-data"
      custom-attribute="${PRIVATE_MARKER}-custom"
    >${PRIVATE_MARKER} arbitrary Grok text</section>
    <main>
      <div
        data-testid="assistant-message"
        dir="auto"
        id="${PRIVATE_MARKER}-answer-id"
        class="${PRIVATE_MARKER}-answer-class"
        data-private="${PRIVATE_MARKER}-answer-data"
      >${PRIVATE_MARKER} answer text</div>
      <div
        class="tiptap ProseMirror ${PRIVATE_MARKER}-composer-class"
        contenteditable="true"
        role="textbox"
        aria-label="Ask Grok anything"
        aria-multiline="true"
        aria-disabled="false"
        id="${PRIVATE_MARKER}-composer-id"
        data-private="${PRIVATE_MARKER}-composer-data"
      ><p>${PRIVATE_MARKER} prompt text</p></div>
      <textarea
        aria-label="Ask Grok anything"
        placeholder="What do you want to know?"
        id="${PRIVATE_MARKER}-textarea-id"
        class="${PRIVATE_MARKER}-textarea-class"
        data-private="${PRIVATE_MARKER}-textarea-data"
      >${PRIVATE_MARKER} alternate prompt text</textarea>
      <button
        data-testid="chat-submit"
        aria-label="Submit"
        type="submit"
        class="${PRIVATE_MARKER}-submit-class"
        data-private="${PRIVATE_MARKER}-submit-data"
      >${PRIVATE_MARKER} submit text</button>
      <div
        data-testid="anon-paywall-sign-up-card"
        id="${PRIVATE_MARKER}-paywall-id"
        class="${PRIVATE_MARKER}-paywall-class"
        data-private="${PRIVATE_MARKER}-paywall-data"
      >${PRIVATE_MARKER} paywall text</div>
      <button
        id="model-select-trigger"
        aria-label="Model select"
        aria-haspopup="menu"
        type="button"
        class="${PRIVATE_MARKER}-model-class"
        data-private="${PRIVATE_MARKER}-model-data"
      >${PRIVATE_MARKER} model text</button>
      <input
        type="file"
        name="files"
        multiple
        class="${PRIVATE_MARKER}-file-class"
        data-private="${PRIVATE_MARKER}-file-data"
      >
      <button
        data-testid="attach-button"
        aria-label="Attach"
        aria-haspopup="menu"
        type="button"
        class="${PRIVATE_MARKER}-attach-class"
        data-private="${PRIVATE_MARKER}-attach-data"
      >${PRIVATE_MARKER} attach text</button>
    </main>
  </body>
</html>`
}
