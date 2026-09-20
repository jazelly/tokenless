import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.dirname(fileURLToPath(import.meta.url))
const compiledRoot = path.join(packageRoot, '..', 'dist', 'compiled')

// Local automation-test variant only: adds standing host_permissions for a whitelisted
// test page so a scripted driver can call chrome.scripting.executeScript without a
// manual click. Never affects the default build/output used as the release candidate.
const isAutomation = process.env.TOKENLESS_EXTENSION_BUILD_VARIANT === 'automation'
const manifestFile = isAutomation ? 'manifest.automation.json' : 'manifest.json'
const outputRoot = path.join(packageRoot, '..', 'dist', isAutomation ? 'unpacked-automation' : 'unpacked')

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(outputRoot, { recursive: true })
fs.copyFileSync(path.join(packageRoot, '..', manifestFile), path.join(outputRoot, 'manifest.json'))
for (const file of ['panel.html', 'panel.css', 'options.html']) {
  fs.copyFileSync(path.join(packageRoot, '..', file), path.join(outputRoot, file))
}
for (const file of fs.readdirSync(compiledRoot)) {
  if (!file.endsWith('.js')) continue
  fs.copyFileSync(path.join(compiledRoot, file), path.join(outputRoot, file))
}
process.stdout.write(`Tokenless Harness extension candidate: ${path.relative(process.cwd(), outputRoot)}\n`)
