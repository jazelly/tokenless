#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../..', import.meta.url))
const surface = 'visible-session-web-ui'

function defineProvider(definition) {
  return Object.freeze({
    ...definition,
    alternateOrigins: Object.freeze(definition.alternateOrigins ?? []),
    selectors: Object.freeze(Object.fromEntries(
      Object.entries(definition.selectors).map(([group, selectors]) => [group, Object.freeze(selectors)])
    )),
  })
}

export const PROVIDER_DEFINITIONS = Object.freeze({
  chatgpt: defineProvider({
    id: 'chatgpt',
    label: 'ChatGPT',
    origin: 'https://chatgpt.com',
    alternateOrigins: ['https://chat.openai.com'],
    url: 'https://chatgpt.com/',
    outputName: 'chatgpt-dom.sanitized.html',
    selectors: {
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
      busy: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop generating" i]',
      ],
      modelPickers: [
        '[data-testid="model-switcher-dropdown-button"]',
        'button[aria-label*="model selector" i]',
      ],
      fileInputs: [
        'input[type="file"]',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
      ],
      projectLinks: [
        'a[href*="/project" i]',
      ],
    },
  }),
  claude: defineProvider({
    id: 'claude',
    label: 'Claude',
    origin: 'https://claude.ai',
    url: 'https://claude.ai/new',
    outputName: 'claude-dom.sanitized.html',
    selectors: {
      composers: [
        'div[data-testid="chat-input"][contenteditable="true"][role="textbox"]',
        'div[aria-label="Write your prompt to Claude"][contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.ProseMirror[contenteditable="true"]',
        'textarea',
      ],
      submits: [
        'button[data-cds="Button"][aria-label="Send message"]',
        'button[aria-label="Send message"]',
        'button[aria-label*="Send"]',
        'button[type="submit"]',
      ],
      answers: [
        '[data-testid="virtual-message-list"] .font-claude-response-body',
        'main .font-claude-response-body',
        '.font-claude-response-body',
      ],
      blockers: [
        'iframe[src*="captcha"]',
        'button[data-testid="login-with-google"]',
        'form:has(input[placeholder="Enter your email"]) button[data-testid="continue"]',
        'input[placeholder="Enter your email"]',
      ],
      busy: [
        '[data-testid="virtual-message-list"] [data-is-streaming="true"]',
        'button[aria-label*="Stop" i]',
      ],
      modelPickers: [
        'button[data-testid="model-selector-dropdown"]',
        'button[data-testid*="model" i]',
        'button[aria-label*="model" i]',
      ],
      fileInputs: [
        'input#chat-input-file-upload-onpage[data-testid="file-upload"][type="file"]',
        'input[data-testid="file-upload"][type="file"]',
        'button[data-cds="Button"][aria-label="Add files, connectors, and more"]',
        'input[type="file"]',
        'button[aria-label*="Attach" i]',
        'button[aria-label*="Upload" i]',
      ],
      projectLinks: [
        'a[href="/projects"][aria-label="Projects"]',
        'a[href="/projects"]',
        'a[href^="/project/"]',
        'a[href*="/project/" i]',
      ],
    },
  }),
  gemini: defineProvider({
    id: 'gemini',
    label: 'Gemini',
    origin: 'https://gemini.google.com',
    url: 'https://gemini.google.com/app',
    outputName: 'gemini-dom.sanitized.html',
    selectors: {
      composers: [
        'rich-textarea div.ql-editor[data-gramm="false"][contenteditable="true"][role="textbox"][aria-multiline="true"][aria-label="Enter a prompt for Gemini"]',
      ],
      submits: [
        'button[aria-label="Send message"]',
      ],
      answers: [
        'response-container message-content',
        'response-container structured-content-container.message-content',
      ],
      blockers: [
        'iframe[src^="https://www.google.com/recaptcha/"][title="reCAPTCHA"]',
      ],
      busy: [
        'button[aria-label="Stop response"]',
      ],
      modelPickers: [
        'button[data-test-id="bard-mode-menu-button"][aria-label^="Open mode picker, currently "]',
      ],
      fileInputs: [
        'button[aria-label="Upload & tools"][aria-haspopup="menu"]',
        'button[data-test-id="local-images-files-uploader-button"][role="menuitem"][aria-label="Upload files. Documents, data, code files"]',
      ],
      projectLinks: [
        'a[href="/gems/view"]',
        'nav a[href="/gems/view"]',
      ],
    },
  }),
  grok: defineProvider({
    id: 'grok',
    label: 'Grok',
    origin: 'https://grok.com',
    url: 'https://grok.com/',
    outputName: 'grok-dom.sanitized.html',
    selectors: {
      composers: [
        'div.tiptap.ProseMirror[contenteditable="true"][role="textbox"][aria-label="Ask Grok anything"][aria-multiline="true"]',
        'textarea[aria-label="Ask Grok anything"][placeholder="What do you want to know?"]',
      ],
      submits: [
        'button[data-testid="chat-submit"][aria-label="Submit"][type="submit"]',
      ],
      answers: [
        'div[data-testid="assistant-message"]',
      ],
      blockers: [
        'div[data-testid="anon-paywall-sign-up-card"]',
      ],
      busy: [],
      modelPickers: [
        'button#model-select-trigger[aria-label="Model select"][aria-haspopup="menu"]',
      ],
      fileInputs: [
        'input[type="file"][name="files"][multiple]',
        'button[data-testid="attach-button"][aria-label="Attach"][aria-haspopup="menu"]',
      ],
      projectLinks: [],
    },
  }),
})

export const providerDefinitions = PROVIDER_DEFINITIONS

export async function captureProviderDom({
  forcedProvider,
  programName = 'test/helpers/capture-provider-dom-cdp.mjs',
} = {}) {
  let args
  let provider
  try {
    args = parseArgs(process.argv.slice(2))
    if (args.help) {
      printHelp({ forcedProvider, programName })
      return { ok: true, help: true }
    }

    if (forcedProvider && args.provider && args.provider !== forcedProvider) {
      throw usageError(
        'provider_mismatch',
        `${programName} captures only ${forcedProvider}; use capture-provider-dom-cdp.mjs for other providers.`
      )
    }
    const providerId = forcedProvider ?? args.provider
    provider = typeof providerId === 'string' && Object.hasOwn(PROVIDER_DEFINITIONS, providerId)
      ? PROVIDER_DEFINITIONS[providerId]
      : null
    if (!provider) {
      throw usageError(
        'unsupported_provider',
        'Provider must be one of: chatgpt, claude, gemini, grok.'
      )
    }
    validateArgs(args)
  } catch (error) {
    const normalized = normalizeError(error)
    console.error(JSON.stringify({ ok: false, ...normalized }, null, 2))
    return { ok: false, ...normalized }
  }

  const cdpUrl = args.cdpUrl ?? process.env.TOKENLESS_CDP_URL ?? 'http://127.0.0.1:9222'
  const publicCdpUrl = sanitizeCdpUrl(cdpUrl)
  const outputRoot = path.resolve(
    args.outputDir ?? path.join(root, 'test-results', captureDirectoryName(provider.outputName))
  )
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDir = path.join(outputRoot, stamp)

  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 })

  let browser
  try {
    browser = await chromium.connectOverCDP(cdpUrl)
    const page = await findProviderPage(browser, provider, args.urlIncludes)
    if (!page) {
      throw usageError(
        `${provider.id}_tab_not_found`,
        `No ${provider.origin}/ tab was found in the CDP browser at ${publicCdpUrl}.`
      )
    }

    const payload = await page.evaluate(({
      providerId,
      surface,
      selectorProbes,
      includeText,
      maxTextChars,
    }) => {
      const sourceRoot = document.documentElement
      const clone = sourceRoot.cloneNode(true)
      const selectorRequirements = collectSelectorRequirements(selectorProbes)

      sanitizeTextNodes(sourceRoot, clone, includeText, maxTextChars)
      sanitizeAttributes(clone, selectorRequirements)
      removeCommentNodes(clone)

      clone.querySelectorAll([
        'script',
        'style',
        'link',
        'meta',
        'noscript',
        'template',
        'iframe',
        'object',
        'embed',
        'input[type="hidden"]',
      ].join(',')).forEach((node) => node.remove())

      clone.querySelectorAll('input, textarea').forEach((node) => {
        if (node.hasAttribute('value')) node.setAttribute('value', '[redacted]')
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
            const firstVisible = matches.find((node) => isVisible(node))
            const rawText = normalizeText(firstVisible?.innerText || firstVisible?.textContent || '')
            firstText = includeText
              ? rawText.slice(0, Math.min(240, maxTextChars))
              : (rawText ? '[text]' : '')
          } catch (probeError) {
            error = String(probeError?.message || probeError).slice(0, 240)
          }
          return { selector, count, firstText, error }
        }),
      ]))

      const visibleText = visibleTextSnapshot(document.body).slice(0, maxTextChars)
      const sanitizedHtml = clone.outerHTML
      return {
        metadata: {
          provider: providerId,
          surface,
          capturedAt: new Date().toISOString(),
          url: publicPageUrl(location.href, providerId),
          title: includeText ? document.title.slice(0, maxTextChars) : '[text]',
          userAgent: navigator.userAgent,
          sanitized: true,
          includeText,
          sanitizedHtmlLength: sanitizedHtml.length,
        },
        probes,
        html: `<!doctype html>\n${sanitizedHtml}`,
        visibleText: includeText ? visibleText : undefined,
      }

      function collectSelectorRequirements(groups) {
        const attributeMatchers = []
        const presenceAttributes = new Set()
        const ids = new Set()
        const classes = new Set()
        const attributePattern = /\[\s*([^\s~|^$*=\]]+)\s*(\^=|\$=|\*=|~=|\|=|=)\s*(["'])(.*?)\3\s*(i)?\s*\]/g
        const presencePattern = /\[\s*([^\s~|^$*=\]]+)\s*\]/g
        const idPattern = /#([A-Za-z_][A-Za-z0-9_-]*)/g
        const classPattern = /\.([A-Za-z_][A-Za-z0-9_-]*)/g
        for (const selectors of Object.values(groups)) {
          for (const selector of selectors) {
            attributePattern.lastIndex = 0
            let match
            while ((match = attributePattern.exec(selector)) !== null) {
              const name = match[1].toLowerCase()
              attributeMatchers.push({
                name,
                operator: match[2],
                expected: match[4],
                caseInsensitive: Boolean(match[5]),
              })
            }
            const selectorWithoutAttributes = selector.replace(/\[[^\]]*\]/g, ' ')
            presencePattern.lastIndex = 0
            while ((match = presencePattern.exec(selector)) !== null) {
              presenceAttributes.add(match[1].toLowerCase())
            }
            idPattern.lastIndex = 0
            while ((match = idPattern.exec(selectorWithoutAttributes)) !== null) ids.add(match[1])
            classPattern.lastIndex = 0
            while ((match = classPattern.exec(selectorWithoutAttributes)) !== null) classes.add(match[1])
          }
        }
        return { attributeMatchers, presenceAttributes, ids, classes }
      }

      function sanitizeTextNodes(source, target, preserveVisibleText, textBudget) {
        const sourceNodes = collectNodes(source, NodeFilter.SHOW_TEXT)
        const targetNodes = collectNodes(target, NodeFilter.SHOW_TEXT)
        let remaining = textBudget
        for (let index = 0; index < targetNodes.length; index += 1) {
          const sourceNode = sourceNodes[index]
          const targetNode = targetNodes[index]
          if (!sourceNode || !targetNode || !targetNode.nodeValue?.trim()) continue
          if (!preserveVisibleText || !isVisibleTextNode(sourceNode) || remaining <= 0) {
            targetNode.nodeValue = '[text]'
            continue
          }
          const preserved = targetNode.nodeValue.slice(0, remaining)
          remaining -= preserved.length
          targetNode.nodeValue = preserved || '[text]'
        }
      }

      function sanitizeAttributes(target, requirements) {
        const booleanAttributes = new Set([
          'checked',
          'disabled',
          'hidden',
          'inert',
          'multiple',
          'open',
          'readonly',
          'required',
          'selected',
        ])
        const enumeratedAttributes = new Map([
          ['aria-atomic', new Set(['true', 'false'])],
          ['aria-busy', new Set(['true', 'false'])],
          ['aria-checked', new Set(['true', 'false', 'mixed'])],
          ['aria-current', new Set(['true', 'false', 'page', 'step', 'location', 'date', 'time'])],
          ['aria-disabled', new Set(['true', 'false'])],
          ['aria-expanded', new Set(['true', 'false'])],
          ['aria-haspopup', new Set(['true', 'false', 'menu', 'listbox', 'tree', 'grid', 'dialog'])],
          ['aria-hidden', new Set(['true', 'false'])],
          ['aria-live', new Set(['off', 'polite', 'assertive'])],
          ['aria-modal', new Set(['true', 'false'])],
          ['aria-multiline', new Set(['true', 'false'])],
          ['aria-pressed', new Set(['true', 'false', 'mixed'])],
          ['aria-readonly', new Set(['true', 'false'])],
          ['aria-required', new Set(['true', 'false'])],
          ['aria-selected', new Set(['true', 'false'])],
          ['aria-sort', new Set(['none', 'ascending', 'descending', 'other'])],
          ['contenteditable', new Set(['true', 'false', 'plaintext-only'])],
          ['draggable', new Set(['true', 'false'])],
          ['role', new Set([
            'alert', 'alertdialog', 'button', 'checkbox', 'combobox', 'dialog', 'document',
            'feed', 'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'link', 'list',
            'listbox', 'listitem', 'log', 'main', 'menu', 'menubar', 'menuitem',
            'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option',
            'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
            'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator',
            'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist',
            'tabpanel', 'textbox', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid',
            'treeitem',
          ])],
          ['spellcheck', new Set(['true', 'false'])],
          ['type', new Set([
            'button', 'checkbox', 'color', 'date', 'datetime-local', 'email', 'file',
            'hidden', 'image', 'month', 'number', 'password', 'radio', 'range', 'reset',
            'search', 'submit', 'tel', 'text', 'time', 'url', 'week',
          ])],
        ])
        const textLikeAttributes = new Set([
          'aria-description',
          'aria-label',
          'aria-placeholder',
          'aria-roledescription',
          'aria-valuetext',
          'alt',
          'content',
          'download',
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
        const targetNodes = [target, ...target.querySelectorAll('*')]

        targetNodes.forEach((node) => {
          for (const attr of [...node.attributes]) {
            const name = attr.name.toLowerCase()
            const sanitized = allowedAttributeValue({
              name,
              value: attr.value,
              requirements,
              booleanAttributes,
              enumeratedAttributes,
              textLikeAttributes,
              urlAttributes,
            })
            if (sanitized === null) node.removeAttribute(attr.name)
            else node.setAttribute(attr.name, sanitized)
          }
        })
      }

      function allowedAttributeValue({
        name,
        value,
        requirements,
        booleanAttributes,
        enumeratedAttributes,
        textLikeAttributes,
        urlAttributes,
      }) {
        if (name === 'id') return requirements.ids.has(value) ? value : null
        if (name === 'class') return sanitizedClassValue(value, requirements)

        const relevant = matchingAttributeValues(name, value, requirements.attributeMatchers)
        if (relevant.length > 0) {
          const kind = urlAttributes.has(name) ? 'url' : (textLikeAttributes.has(name) ? 'text' : 'structural')
          return selectorSafeValue(relevant, kind)
        }
        if (requirements.presenceAttributes.has(name)) return ''
        if (booleanAttributes.has(name)) return ''
        if (name === 'tabindex' && /^-?\d{1,3}$/.test(value.trim())) return value.trim()
        const allowedValues = enumeratedAttributes.get(name)
        const normalized = value.trim().toLowerCase()
        if (allowedValues?.has(normalized)) return normalized
        if (urlAttributes.has(name)) return '[url]'
        return null
      }

      function sanitizedClassValue(value, requirements) {
        const safeTokens = value
          .split(/\s+/)
          .filter((token) => requirements.classes.has(token))
        const relevant = matchingAttributeValues('class', value, requirements.attributeMatchers)
        if (relevant.length > 0) safeTokens.push(selectorSafeValue(relevant, 'structural'))
        const uniqueTokens = [...new Set(safeTokens.filter(Boolean))]
        return uniqueTokens.length > 0 ? uniqueTokens.join(' ') : null
      }

      function selectorSafeValue(matchers, kind) {
        const exact = matchers.find((matcher) => matcher.operator === '=')
        if (exact) {
          if (kind !== 'url' || isSafeStaticPath(exact.expected)) return exact.expected
          return '[url]'
        }

        const prefix = matchers.find((matcher) => matcher.operator === '^=')?.expected ?? ''
        const suffix = matchers.find((matcher) => matcher.operator === '$=')?.expected ?? ''
        const middle = uniqueFragments(matchers.filter((matcher) => !['^=', '$='].includes(matcher.operator)))
        const marker = `[${kind}]`
        return `${prefix}${marker}${middle.join(marker)}${suffix}`
      }

      function isSafeStaticPath(value) {
        return /^\/[A-Za-z0-9/_-]*$/.test(value)
      }

      function matchingAttributeValues(name, value, matchers) {
        return matchers.filter((matcher) => {
          if (matcher.name !== name) return false
          const actual = matcher.caseInsensitive ? value.toLowerCase() : value
          const expected = matcher.caseInsensitive ? matcher.expected.toLowerCase() : matcher.expected
          if (matcher.operator === '=') return actual === expected
          if (matcher.operator === '*=') return actual.includes(expected)
          if (matcher.operator === '^=') return actual.startsWith(expected)
          if (matcher.operator === '$=') return actual.endsWith(expected)
          if (matcher.operator === '~=') return actual.split(/\s+/).includes(expected)
          if (matcher.operator === '|=') return actual === expected || actual.startsWith(`${expected}-`)
          return false
        })
      }

      function uniqueFragments(matchers) {
        return [...new Set(matchers.map((matcher) => matcher.expected.replace(/[\[\]|]/g, '')))]
      }

      function collectNodes(node, whatToShow) {
        const walker = document.createTreeWalker(node, whatToShow)
        const nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        return nodes
      }

      function removeCommentNodes(node) {
        for (const comment of collectNodes(node, NodeFilter.SHOW_COMMENT)) {
          comment.parentNode?.removeChild(comment)
        }
      }

      function isVisibleTextNode(node) {
        if (!node.nodeValue?.trim() || !node.parentElement || !isVisible(node.parentElement)) return false
        const range = document.createRange()
        range.selectNodeContents(node)
        return [...range.getClientRects()].some((rect) => rectIntersectsViewport(rect))
      }

      function visibleTextSnapshot(node) {
        if (!node) return ''
        return normalizeText(
          collectNodes(node, NodeFilter.SHOW_TEXT)
            .filter((textNode) => isVisibleTextNode(textNode))
            .map((textNode) => textNode.nodeValue || '')
            .join(' ')
        )
      }

      function isVisible(node) {
        if (!(node instanceof Element) || !node.isConnected) return false
        const style = getComputedStyle(node)
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse' ||
          Number(style.opacity) === 0
        ) {
          return false
        }
        return [...node.getClientRects()].some((rect) => rectIntersectsViewport(rect))
      }

      function rectIntersectsViewport(rect) {
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth
        )
      }

      function publicPageUrl(url, provider) {
        try {
          const parsed = new URL(url)
          const pathname = redactedProviderPath(parsed.pathname, provider)
          return `${parsed.origin}${pathname}`
        } catch {
          return ''
        }
      }

      function redactedProviderPath(pathname, provider) {
        const normalized = pathname.replace(/\/+$/, '') || '/'
        const staticPaths = {
          chatgpt: new Set(['/']),
          claude: new Set(['/new']),
          gemini: new Set(['/app', '/gems/view']),
          grok: new Set(['/']),
        }
        if (staticPaths[provider]?.has(normalized)) return normalized

        const knownRoutePrefixes = {
          chatgpt: new Set(['c', 'g']),
          claude: new Set(['chat']),
          gemini: new Set(['app', 'gems', 'share']),
          grok: new Set(['c', 'share']),
        }
        const firstSegment = normalized.split('/').filter(Boolean)[0]
        return firstSegment && knownRoutePrefixes[provider]?.has(firstSegment)
          ? `/${firstSegment}/[redacted]`
          : '/[redacted]'
      }

      function normalizeText(text) {
        return String(text).replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
      }
    }, {
      providerId: provider.id,
      surface,
      selectorProbes: provider.selectors,
      includeText: Boolean(args.includeText),
      maxTextChars: Number(args.maxTextChars ?? 4000),
    })

    const htmlPath = path.join(outputDir, provider.outputName)
    const selectorProbesPath = path.join(outputDir, 'selector-probes.json')
    const metadataPath = path.join(outputDir, 'metadata.json')
    const visibleTextPath = payload.visibleText === undefined
      ? null
      : path.join(outputDir, 'visible-text.txt')

    await Promise.all([
      fs.writeFile(htmlPath, `${payload.html}\n`, { encoding: 'utf8', mode: 0o600 }),
      fs.writeFile(
        selectorProbesPath,
        `${JSON.stringify(payload.probes, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      ),
      fs.writeFile(
        metadataPath,
        `${JSON.stringify(payload.metadata, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 }
      ),
      visibleTextPath
        ? fs.writeFile(visibleTextPath, `${payload.visibleText}\n`, { encoding: 'utf8', mode: 0o600 })
        : Promise.resolve(),
    ])

    const result = {
      ok: true,
      provider: provider.id,
      surface,
      cdpUrl: publicCdpUrl,
      outputDir,
      url: payload.metadata.url,
      title: payload.metadata.title,
      htmlPath,
      selectorProbesPath,
      metadataPath,
      visibleTextPath,
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } catch (error) {
    const normalized = normalizeError(error, { cdpUrl: publicCdpUrl, provider })
    const result = {
      ok: false,
      provider: provider.id,
      surface,
      ...normalized,
      outputDir,
    }
    await fs.writeFile(
      path.join(outputDir, 'error.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    ).catch(() => undefined)
    console.error(JSON.stringify(result, null, 2))
    return result
  } finally {
    disconnectFromCdp(browser)
  }
}

// connectOverCDP attaches to a browser that this helper does not own. Calling
// Browser.close() can wait indefinitely on a remote connection and may request
// shutdown of the user's browser; close only the Playwright transport instead.
export function disconnectFromCdp(browser) {
  const connection = browser?._connection
  if (connection && typeof connection.close === 'function') connection.close()
}

async function findProviderPage(browser, provider, urlIncludes) {
  const origins = new Set([provider.origin, ...provider.alternateOrigins])
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      let parsed
      try {
        parsed = new URL(page.url())
      } catch {
        continue
      }
      if (parsed.username || parsed.password) continue
      if (!origins.has(parsed.origin)) continue
      if (urlIncludes && !parsed.href.includes(urlIncludes)) continue
      return page
    }
  }
  return null
}

function captureDirectoryName(outputName) {
  return outputName.endsWith('.sanitized.html')
    ? `${outputName.slice(0, -'.sanitized.html'.length)}-captures`
    : `${path.parse(outputName).name}-captures`
}

function sanitizeCdpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.origin
  } catch {
    return '[cdp-endpoint]'
  }
}

function normalizeError(error, { cdpUrl, provider } = {}) {
  if (error?.code && typeof error.code === 'string') {
    return { code: error.code, message: sanitizeErrorMessage(error.message) }
  }
  const message = String(error?.message || error)
  if (message.includes('ECONNREFUSED') || message.includes('connect ECONNREFUSED')) {
    return {
      code: 'cdp_unavailable',
      message: `No Chrome DevTools Protocol endpoint is listening at ${cdpUrl}. Start Chrome with --remote-debugging-port or pass --cdp-url.`,
      launchExample: `chrome --remote-debugging-port=9222 --user-data-dir=<dedicated-profile> ${provider?.url ?? '<provider-url>'}`,
    }
  }
  return { code: 'capture_failed', message: sanitizeErrorMessage(message) }
}

function sanitizeErrorMessage(value) {
  return String(value ?? 'Capture failed.')
    .replace(/(?:https?|wss?):\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9_-]{80,}/g, '[redacted]')
    .slice(0, 500)
}

function usageError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function validateArgs(args) {
  if (args.maxTextChars !== undefined) {
    const maxTextChars = Number(args.maxTextChars)
    if (!Number.isInteger(maxTextChars) || maxTextChars < 1 || maxTextChars > 100000) {
      throw usageError('invalid_max_text_chars', '--max-text-chars must be an integer from 1 to 100000.')
    }
  }
}

function parseArgs(argv) {
  const parsed = {}
  const valueFor = (option, index) => {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) {
      throw usageError('missing_option_value', `${option} requires a value.`)
    }
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--provider') {
      parsed.provider = valueFor(arg, index)
      index += 1
    } else if (arg === '--cdp-url') {
      parsed.cdpUrl = valueFor(arg, index)
      index += 1
    } else if (arg === '--include-text') {
      parsed.includeText = true
    } else if (arg === '--url-includes') {
      parsed.urlIncludes = valueFor(arg, index)
      index += 1
    } else if (arg === '--output-dir') {
      parsed.outputDir = valueFor(arg, index)
      index += 1
    } else if (arg === '--max-text-chars') {
      parsed.maxTextChars = valueFor(arg, index)
      index += 1
    } else if (arg === '--help') {
      parsed.help = true
    } else {
      throw usageError('unknown_argument', `Unknown argument: ${arg}`)
    }
  }
  return parsed
}

function printHelp({ forcedProvider, programName }) {
  const provider = forcedProvider ? PROVIDER_DEFINITIONS[forcedProvider] : null
  const providerOption = forcedProvider ? '' : ' --provider <provider>'
  console.log([
    `Usage: node ${programName}${providerOption} [options]`,
    '',
    provider
      ? `Captures a sanitized DOM snapshot from a CDP-enabled Chrome ${provider.label} tab.`
      : 'Captures a sanitized DOM snapshot from a provider tab in CDP-enabled Chrome.',
    '',
    ...(provider ? [] : [
      'Providers:',
      '  chatgpt | claude | gemini | grok',
      '',
    ]),
    'Options:',
    ...(forcedProvider ? [] : ['  --provider <provider>   Provider whose tab should be captured.']),
    '  --cdp-url <url>         CDP endpoint. Defaults to http://127.0.0.1:9222.',
    `  --url-includes <text>   Select the ${provider?.label ?? 'provider'} tab whose URL contains text.`,
    '  --output-dir <path>     Directory root for capture artifacts.',
    '  --include-text          Preserve only visible text in the DOM and a separate artifact.',
    '  --max-text-chars <n>    Visible text limit (1-100000) with --include-text.',
    '  --help                  Show this help.',
  ].join('\n'))
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  )
}

if (isMainModule()) {
  const result = await captureProviderDom()
  if (!result.ok) process.exitCode = 1
}
