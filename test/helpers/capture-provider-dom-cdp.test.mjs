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
  PROVIDER_DEFINITIONS,
} from './capture-provider-dom-cdp.mjs'

const PRIVATE_MARKER = 'TOKENLESS_PRIVATE_ATTRIBUTE_MARKER_7f41d9'
const EXACT_GROUPS = ['composers', 'submits', 'answers', 'fileInputs', 'projectLinks']

test('capture sanitizer preserves provider selectors without retaining arbitrary attribute values', {
  timeout: 30000,
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
    await browser.close()
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
  } finally {
    await browser?.close().catch(() => undefined)
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
  try {
    const cleanupBrowser = await chromium.connectOverCDP(endpoint)
    const session = await cleanupBrowser.newBrowserCDPSession()
    await session.send('Browser.close').catch(() => undefined)
  } catch {
    // The controlled process may already be gone after a failed assertion.
  }
  if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit'), delay(3000)])
  if (chrome.exitCode === null) chrome.kill()
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
