#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'packages/contracts/tokenless.openapi.json')
const overlayPath = path.join(root, 'packages/contracts/tokenless.zh-CN.overlay.json')
const outputPaths = {
  en: path.join(root, 'packages/contracts/reference.html'),
  'zh-CN': path.join(root, 'packages/contracts/reference.zh-CN.html'),
}
const check = process.argv.includes('--check')
const document = JSON.parse(await fs.readFile(sourcePath, 'utf8'))
const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf8'))
const localizedDocument = applyTextOverlay(document, overlay)
const pages = {
  en: renderReference(document, {
    lang: 'en',
    pageTitle: 'Tokenless HTTP API Reference',
    partnerHref: 'reference.zh-CN.html',
    partnerLabel: '简体中文',
  }),
  'zh-CN': renderReference(localizedDocument, {
    lang: 'zh-CN',
    pageTitle: 'Tokenless HTTP API 参考',
    partnerHref: 'reference.html',
    partnerLabel: 'English',
  }),
}

if (check) {
  for (const [language, outputPath] of Object.entries(outputPaths)) {
    const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
    if (current !== pages[language]) {
      throw new Error(`${path.relative(root, outputPath)} is stale; run npm run api:docs`)
    }
  }
  console.log('api:docs verified packages/contracts/reference.html and reference.zh-CN.html')
} else {
  for (const [language, outputPath] of Object.entries(outputPaths)) {
    await fs.writeFile(outputPath, pages[language])
  }
  console.log('api:docs generated packages/contracts/reference.html and reference.zh-CN.html')
}

function renderReference(openApiDocument, { lang, pageTitle, partnerHref, partnerLabel }) {
  const content = JSON.stringify(openApiDocument).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${pageTitle}</title>
  </head>
  <body>
    <nav aria-label="Language"><a href="${partnerHref}">${partnerLabel}</a></nav>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.65.1"></script>
    <script>
      Scalar.createApiReference('#app', {
        content: ${content},
        layout: 'modern',
        theme: 'default',
        pageTitle: '${pageTitle}'
      })
    </script>
  </body>
</html>
`
}

function applyTextOverlay(source, parsedOverlay) {
  if (parsedOverlay?.overlay !== '1.1.0' || parsedOverlay?.extends !== './tokenless.openapi.json') {
    throw new Error('packages/contracts/tokenless.zh-CN.overlay.json must extend ./tokenless.openapi.json using Overlay 1.1.0')
  }
  if (!Array.isArray(parsedOverlay.actions)) throw new Error('Chinese OpenAPI overlay must include actions')

  const expectedTargets = collectTextTargets(source)
  const seen = new Set()
  const result = structuredClone(source)
  for (const action of parsedOverlay.actions) {
    if (!action || typeof action !== 'object' || typeof action.target !== 'string' || typeof action.update !== 'string') {
      throw new Error('Each Chinese OpenAPI overlay action must include a string target and update')
    }
    if (seen.has(action.target)) throw new Error(`Duplicate Chinese OpenAPI overlay target: ${action.target}`)
    if (!expectedTargets.has(action.target)) throw new Error(`Unknown Chinese OpenAPI overlay target: ${action.target}`)
    setExactJsonPath(result, action.target, action.update)
    seen.add(action.target)
  }
  const missing = [...expectedTargets].filter((target) => !seen.has(target))
  if (missing.length > 0) throw new Error(`Chinese OpenAPI overlay is missing: ${missing.join(', ')}`)
  return result
}

function collectTextTargets(value, target = '$', found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectTextTargets(child, `${target}[${index}]`, found))
    return found
  }
  if (!value || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value)) {
    const childTarget = `${target}[${JSON.stringify(key)}]`
    if (['title', 'summary', 'description'].includes(key) && typeof child === 'string') found.add(childTarget)
    collectTextTargets(child, childTarget, found)
  }
  return found
}

function setExactJsonPath(document, target, update) {
  if (!target.startsWith('$')) throw new Error(`Unsupported OpenAPI overlay target: ${target}`)
  const parts = []
  const matcher = /\[(\d+|"(?:[^"\\]|\\.)*")\]/g
  let offset = 1
  for (const match of target.matchAll(matcher)) {
    if (match.index !== offset) throw new Error(`Unsupported OpenAPI overlay target: ${target}`)
    parts.push(match[1].startsWith('"') ? JSON.parse(match[1]) : Number(match[1]))
    offset = match.index + match[0].length
  }
  if (offset !== target.length || parts.length === 0) throw new Error(`Unsupported OpenAPI overlay target: ${target}`)
  let current = document
  for (const part of parts.slice(0, -1)) current = current[part]
  current[parts.at(-1)] = update
}
