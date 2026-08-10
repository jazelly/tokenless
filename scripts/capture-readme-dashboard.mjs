import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(repositoryRoot, 'assets', 'dashboard-hero.png')
const profile = optionValue('--profile')

if (!profile) {
  throw new Error('Usage: npm run docs:capture-readme-dashboard -- --profile <managed-profile-slug>')
}

const cliEntry = path.join(repositoryRoot, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')
const dashboard = JSON.parse(execFileSync(process.execPath, [
  cliEntry,
  'dashboard',
  '--profile', profile,
  '--no-open',
  '--json',
], { encoding: 'utf8' }))

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({
    colorScheme: 'light',
    locale: 'en-US',
    viewport: { width: 1920, height: 1080 },
  })
  await page.goto(dashboard.dashboard.url, { waitUntil: 'networkidle' })
  await page.getByTestId('overview-view').waitFor()
  await page.screenshot({ path: outputPath })
  console.log(`Captured ${path.relative(repositoryRoot, outputPath)} from managed profile '${profile}'.`)
} finally {
  await browser.close()
}

function optionValue(name) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : ''
  return value || null
}
