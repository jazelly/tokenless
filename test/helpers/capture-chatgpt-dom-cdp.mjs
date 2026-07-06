#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const root = path.resolve(new URL('../..', import.meta.url).pathname)
const args = parseArgs(process.argv.slice(2))
const cdpUrl = args.cdpUrl ?? process.env.TOKENLESS_CDP_URL ?? 'http://127.0.0.1:9222'
const outputRoot = path.resolve(args.outputDir ?? path.join(root, 'test-results', 'chatgpt-dom-captures'))
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = path.join(outputRoot, stamp)

const selectorProbes = Object.freeze({
  composers: [
    'div#prompt-textarea[contenteditable="true"]',
    '#prompt-textarea[contenteditable="true"]',
    '[data-testid="composer"] [contenteditable="true"]',
    'div[contenteditable="true"][data-id="root"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[placeholder*="Message" i]',
    'textarea[data-testid="prompt-textarea"]',
    'textarea',
  ],
  submits: [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
  ],
  answers: [
    '[data-message-author-role="assistant"]',
    'article[data-testid*="conversation-turn"]',
    'main article',
  ],
  blockers: [
    'iframe[src*="captcha"]',
    '[aria-label*="captcha" i]',
  ],
})

await fs.mkdir(outputDir, { recursive: true })

let browser
try {
  browser = await chromium.connectOverCDP(cdpUrl)
  const page = await findChatGptPage(browser, args.urlIncludes)
  if (!page) {
    throw usageError(
      'chatgpt_tab_not_found',
      `No https://chatgpt.com/ tab was found in the CDP browser at ${cdpUrl}.`
    )
  }

  const payload = await page.evaluate(({ selectorProbes, includeText, maxTextChars }) => {
    const clone = document.documentElement.cloneNode(true)
    const removedSelectors = [
      'script',
      'noscript',
      'iframe[src*="accounts.google.com"]',
      'iframe[src*="challenge-platform"]',
    ]
    clone.querySelectorAll(removedSelectors.join(',')).forEach((node) => node.remove())
    clone.querySelectorAll('input, textarea').forEach((node) => {
      if (node.hasAttribute('value')) node.setAttribute('value', '[redacted]')
      node.textContent = includeText ? node.textContent : ''
    })
    clone.querySelectorAll('[contenteditable="true"]').forEach((node) => {
      if (!includeText) node.textContent = ''
    })
    if (!includeText) {
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
      const textNodes = []
      while (walker.nextNode()) textNodes.push(walker.currentNode)
      for (const node of textNodes) {
        if (node.nodeValue.trim()) node.nodeValue = '[text]'
      }
    }
    const textLikeAttributes = new Set([
      'aria-description',
      'aria-label',
      'alt',
      'content',
      'label',
      'placeholder',
      'title',
    ])
    const urlAttributes = new Set([
      'action',
      'formaction',
      'href',
      'poster',
      'src',
      'srcset',
    ])
    clone.querySelectorAll('*').forEach((node) => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase()
        if (
          name.includes('token') ||
          name.includes('secret') ||
          name.includes('email') ||
          name.includes('password') ||
          name.includes('session') ||
          name.includes('auth') ||
          name === 'srcdoc'
        ) {
          node.setAttribute(attr.name, '[redacted]')
        } else if (urlAttributes.has(name) && attr.value.trim()) {
          node.setAttribute(attr.name, '[url]')
        } else if (!includeText && textLikeAttributes.has(name) && attr.value.trim()) {
          node.setAttribute(attr.name, '[text]')
        }
      }
    })

    const probes = Object.fromEntries(Object.entries(selectorProbes).map(([group, selectors]) => [
      group,
      selectors.map((selector) => {
        let count = 0
        let firstText = ''
        let error = null
        try {
          const matches = [...document.querySelectorAll(selector)]
          count = matches.length
          const rawText = normalizeText(matches[0]?.innerText || matches[0]?.textContent || '')
          firstText = includeText ? rawText.slice(0, 240) : (rawText ? '[text]' : '')
        } catch (probeError) {
          error = probeError.message
        }
        return { selector, count, firstText, error }
      }),
    ]))

    const visibleText = normalizeText(document.body?.innerText || '').slice(0, maxTextChars)
    return {
      metadata: {
        capturedAt: new Date().toISOString(),
        url: location.href,
        title: includeText ? document.title : '[text]',
        userAgent: navigator.userAgent,
        sanitized: true,
        includeText,
        htmlLength: document.documentElement.outerHTML.length,
        sanitizedHtmlLength: clone.outerHTML.length,
      },
      probes,
      html: `<!doctype html>\n${clone.outerHTML}`,
      visibleText: includeText ? visibleText : undefined,
    }

    function normalizeText(text) {
      return String(text).replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    }
  }, {
    selectorProbes,
    includeText: Boolean(args.includeText),
    maxTextChars: Number(args.maxTextChars ?? 4000),
  })

  await fs.writeFile(path.join(outputDir, 'chatgpt-dom.sanitized.html'), `${payload.html}\n`, 'utf8')
  await fs.writeFile(path.join(outputDir, 'selector-probes.json'), `${JSON.stringify(payload.probes, null, 2)}\n`, 'utf8')
  await fs.writeFile(path.join(outputDir, 'metadata.json'), `${JSON.stringify(payload.metadata, null, 2)}\n`, 'utf8')
  if (payload.visibleText !== undefined) {
    await fs.writeFile(path.join(outputDir, 'visible-text.txt'), `${payload.visibleText}\n`, 'utf8')
  }

  console.log(JSON.stringify({
    ok: true,
    cdpUrl,
    outputDir,
    url: payload.metadata.url,
    title: payload.metadata.title,
    htmlPath: path.join(outputDir, 'chatgpt-dom.sanitized.html'),
    selectorProbesPath: path.join(outputDir, 'selector-probes.json'),
    metadataPath: path.join(outputDir, 'metadata.json'),
    visibleTextPath: payload.visibleText === undefined ? null : path.join(outputDir, 'visible-text.txt'),
  }, null, 2))
} catch (error) {
  const normalized = normalizeError(error, cdpUrl)
  await fs.writeFile(path.join(outputDir, 'error.json'), `${JSON.stringify({
    ok: false,
    ...normalized,
    outputDir,
  }, null, 2)}\n`, 'utf8').catch(() => undefined)
  console.error(JSON.stringify({
    ok: false,
    ...normalized,
    outputDir,
  }, null, 2))
  process.exit(1)
} finally {
  await browser?.close().catch(() => undefined)
}

async function findChatGptPage(browser, urlIncludes) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const url = page.url()
      if (!url.startsWith('https://chatgpt.com/')) continue
      if (urlIncludes && !url.includes(urlIncludes)) continue
      return page
    }
  }
  return null
}

function normalizeError(error, cdpUrl) {
  if (error?.code && typeof error.code === 'string') {
    return { code: error.code, message: error.message }
  }
  const message = String(error?.message || error)
  if (message.includes('ECONNREFUSED') || message.includes('connect ECONNREFUSED')) {
    return {
      code: 'cdp_unavailable',
      message: `No Chrome DevTools Protocol endpoint is listening at ${cdpUrl}. Start Chrome with --remote-debugging-port or pass --cdp-url.`,
      launchExample: '/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/tokenless-cdp-chrome-profile https://chatgpt.com/',
    }
  }
  return { code: 'capture_failed', message }
}

function usageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--cdp-url') {
      parsed.cdpUrl = argv[++index]
    } else if (arg === '--include-text') {
      parsed.includeText = true
    } else if (arg === '--url-includes') {
      parsed.urlIncludes = argv[++index]
    } else if (arg === '--output-dir') {
      parsed.outputDir = argv[++index]
    } else if (arg === '--max-text-chars') {
      parsed.maxTextChars = argv[++index]
    } else if (arg === '--help') {
      console.log([
        'Usage: node test/helpers/capture-chatgpt-dom-cdp.mjs [options]',
        '',
        'Captures a sanitized DOM snapshot from a CDP-enabled Chrome ChatGPT tab.',
        '',
        'Start Chrome for capture:',
        '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/tokenless-cdp-chrome-profile https://chatgpt.com/',
        '',
        'Options:',
        '  --cdp-url <url>         CDP endpoint. Defaults to http://127.0.0.1:9222.',
        '  --url-includes <text>   Select the ChatGPT tab whose URL contains text.',
        '  --output-dir <path>     Directory root for capture artifacts.',
        '  --include-text          Preserve visible text in a separate artifact and DOM snapshot.',
        '  --max-text-chars <n>    Visible text character limit when --include-text is set.',
      ].join('\n'))
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return parsed
}
