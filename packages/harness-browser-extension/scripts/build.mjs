import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const compiledRoot = path.join(packageRoot, '..', 'dist', 'compiled')
const outputRoot = path.join(packageRoot, '..', 'dist', 'unpacked')

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(outputRoot, { recursive: true })
for (const file of ['manifest.json', 'panel.html', 'panel.css']) {
  fs.copyFileSync(path.join(packageRoot, '..', file), path.join(outputRoot, file))
}
for (const file of fs.readdirSync(compiledRoot)) {
  if (!file.endsWith('.js')) continue
  fs.copyFileSync(path.join(compiledRoot, file), path.join(outputRoot, file))
}
process.stdout.write(`Tokenless Harness extension candidate: ${path.relative(process.cwd(), outputRoot)}\n`)
