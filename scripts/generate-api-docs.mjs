#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(root, 'packages/contracts/tokenless.openapi.json')
const outputPath = path.join(root, 'packages/contracts/reference.html')
const check = process.argv.includes('--check')
const document = JSON.parse(await fs.readFile(sourcePath, 'utf8'))
const content = JSON.stringify(document).replaceAll('<', '\\u003c')
const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Tokenless HTTP API Reference</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.65.1"></script>
    <script>
      Scalar.createApiReference('#app', {
        content: ${content},
        layout: 'modern',
        theme: 'default',
        pageTitle: 'Tokenless HTTP API Reference'
      })
    </script>
  </body>
</html>
`

if (check) {
  const current = await fs.readFile(outputPath, 'utf8').catch(() => '')
  if (current !== html) throw new Error('packages/contracts/reference.html is stale; run npm run api:docs')
  console.log('api:docs verified packages/contracts/reference.html')
} else {
  await fs.writeFile(outputPath, html)
  console.log('api:docs generated packages/contracts/reference.html')
}
