#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = path.resolve(new URL('../..', import.meta.url).pathname)

const args = parseArgs(process.argv.slice(2))
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

try {
  const payload = await captureFromChrome({
    urlIncludes: args.urlIncludes,
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
    outputDir,
    url: payload.metadata.url,
    title: payload.metadata.title,
    htmlPath: path.join(outputDir, 'chatgpt-dom.sanitized.html'),
    selectorProbesPath: path.join(outputDir, 'selector-probes.json'),
    metadataPath: path.join(outputDir, 'metadata.json'),
    visibleTextPath: payload.visibleText === undefined ? null : path.join(outputDir, 'visible-text.txt'),
  }, null, 2))
} catch (error) {
  const normalizedError = normalizeCaptureError(error)
  await fs.writeFile(path.join(outputDir, 'error.json'), `${JSON.stringify({
    ok: false,
    code: normalizedError.code,
    message: normalizedError.message,
    outputDir,
  }, null, 2)}\n`, 'utf8').catch(() => undefined)
  console.error(JSON.stringify({
    ok: false,
    code: normalizedError.code,
    message: normalizedError.message,
    outputDir,
    nextStep: normalizedError.code === 'chrome_apple_events_javascript_disabled'
      ? 'In Google Chrome, enable View > Developer > Allow JavaScript from Apple Events, then rerun this helper.'
      : undefined,
  }, null, 2))
  process.exit(1)
}

async function captureFromChrome({ urlIncludes, includeText, maxTextChars }) {
  const browserJs = browserCaptureScript({ selectorProbes, includeText, maxTextChars })
  const appleScript = chromeCaptureAppleScript({ browserJs, urlIncludes })
  const { stdout } = await execFileAsync('osascript', ['-e', appleScript], {
    maxBuffer: 20 * 1024 * 1024,
  })
  const raw = stdout.trim()
  if (!raw) {
    const error = new Error('No matching https://chatgpt.com/ tab was found in Google Chrome.')
    error.code = 'chatgpt_tab_not_found'
    throw error
  }
  return JSON.parse(raw)
}

function chromeCaptureAppleScript({ browserJs, urlIncludes }) {
  const jsLiteral = appleString(browserJs)
  const urlIncludesLiteral = appleString(urlIncludes ?? '')
  return `
set urlNeedle to ${urlIncludesLiteral}
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      set tabUrl to URL of t
      if tabUrl starts with "https://chatgpt.com/" then
        if urlNeedle is "" or tabUrl contains urlNeedle then
          return execute t javascript ${jsLiteral}
        end if
      end if
    end repeat
  end repeat
end tell
return ""
`
}

function browserCaptureScript({ selectorProbes, includeText, maxTextChars }) {
  return `(() => {
    const selectorProbes = ${JSON.stringify(selectorProbes)};
    const includeText = ${JSON.stringify(includeText)};
    const maxTextChars = ${JSON.stringify(maxTextChars)};
    const clone = document.documentElement.cloneNode(true);
    const removedSelectors = [
      'script',
      'noscript',
      'iframe[src*="accounts.google.com"]',
      'iframe[src*="challenge-platform"]'
    ];
    clone.querySelectorAll(removedSelectors.join(',')).forEach((node) => node.remove());
    clone.querySelectorAll('input, textarea').forEach((node) => {
      if (node.hasAttribute('value')) node.setAttribute('value', '[redacted]');
      node.textContent = includeText ? node.textContent : '';
    });
    clone.querySelectorAll('[contenteditable="true"]').forEach((node) => {
      if (!includeText) node.textContent = '';
    });
    if (!includeText) {
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      for (const node of textNodes) {
        if (node.nodeValue.trim()) node.nodeValue = '[text]';
      }
    }
    clone.querySelectorAll('*').forEach((node) => {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        if (
          name.includes('token') ||
          name.includes('secret') ||
          name.includes('email') ||
          name === 'srcdoc'
        ) {
          node.setAttribute(attr.name, '[redacted]');
        }
      }
    });
    const probeGroups = Object.fromEntries(Object.entries(selectorProbes).map(([group, selectors]) => [
      group,
      selectors.map((selector) => {
        let count = 0;
        let firstText = '';
        let error = null;
        try {
          const matches = [...document.querySelectorAll(selector)];
          count = matches.length;
          const rawText = normalizeText(matches[0]?.innerText || matches[0]?.textContent || '');
          firstText = includeText ? rawText.slice(0, 240) : (rawText ? '[text]' : '');
        } catch (probeError) {
          error = probeError.message;
        }
        return { selector, count, firstText, error };
      })
    ]));
    const visibleText = normalizeText(document.body?.innerText || '').slice(0, maxTextChars);
    return JSON.stringify({
      metadata: {
        capturedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        userAgent: navigator.userAgent,
        sanitized: true,
        includeText,
        htmlLength: document.documentElement.outerHTML.length,
        sanitizedHtmlLength: clone.outerHTML.length,
      },
      probes: probeGroups,
      html: '<!doctype html>\\n' + clone.outerHTML,
      visibleText: includeText ? visibleText : undefined,
    });
    function normalizeText(text) {
      return String(text).replace(/\\s+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    }
  })()`
}

function appleString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--include-text') {
      parsed.includeText = true
    } else if (arg === '--url-includes') {
      parsed.urlIncludes = argv[++index]
    } else if (arg === '--output-dir') {
      parsed.outputDir = argv[++index]
    } else if (arg === '--max-text-chars') {
      parsed.maxTextChars = argv[++index]
    } else if (arg === '--help') {
      console.log([
        'Usage: node test/helpers/capture-existing-chrome-chatgpt-dom.mjs [options]',
        '',
        'Captures a sanitized DOM snapshot from an already-open Google Chrome ChatGPT tab.',
        'Chrome must have View > Developer > Allow JavaScript from Apple Events enabled.',
        '',
        'Options:',
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

function normalizeCaptureError(error) {
  const message = String(error?.stderr || error?.message || error)
  if (message.includes('Executing JavaScript through AppleScript is turned off')) {
    return {
      code: 'chrome_apple_events_javascript_disabled',
      message: 'Google Chrome has View > Developer > Allow JavaScript from Apple Events turned off.',
    }
  }
  return {
    code: error?.code && typeof error.code === 'string' ? error.code : 'capture_failed',
    message: message.split('\n').at(-2)?.trim() || message.slice(0, 500),
  }
}
