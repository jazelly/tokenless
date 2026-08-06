import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

import { BrowserRuntimeManager } from '../packages/cli/dist/src/browser-runtime/manager.js'
import { listProviderDescriptors } from '../packages/cli/dist/src/providers/registry.js'

if (process.env.TOKENLESS_LIVE_BROWSER_SURFACE_GATE !== '1') {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_SURFACE_GATE=1 to run the real browser provider-surface acceptance gate.')
}
if (!(
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'win32' && process.arch === 'x64')
)) {
  throw new Error(`The browser surface gate does not support ${process.platform}-${process.arch}.`)
}

const selection = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_SELECTION
if (!['auto', 'chrome', 'managed-chromium', 'cloak'].includes(selection)) {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_SURFACE_SELECTION to auto, chrome, managed-chromium, or cloak.')
}
const visibility = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_VISIBILITY
if (!['headed', 'headless'].includes(visibility)) {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_SURFACE_VISIBILITY to headed or headless.')
}
const fallbackSelection = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_FALLBACK_SELECTION?.trim() || null
if (fallbackSelection !== null && !['auto', 'chrome', 'managed-chromium', 'cloak'].includes(fallbackSelection)) {
  throw new Error('TOKENLESS_LIVE_BROWSER_SURFACE_FALLBACK_SELECTION must be auto, chrome, managed-chromium, or cloak.')
}
if (fallbackSelection === selection) {
  throw new Error('Browser surface fallback selection must differ from the primary selection.')
}

test(`${selection} ${visibility} reaches every provider surface and Google Search${fallbackSelection ? ` with ${fallbackSelection} fallback` : ' without a detected anti-bot challenge'}`, { timeout: 20 * 60_000 }, async () => {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const suppliedHome = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_HOME
  const homeDir = suppliedHome
    ? path.resolve(suppliedHome)
    : await fs.mkdtemp(path.join(temporaryRoot, 'tokenless-browser-surface-home-'))
  const ownsHome = !suppliedHome
  const evidence = {
    schema: 'tokenless.live-browser-surface-fallback-result.v2',
    observedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    visibility,
    primary: null,
    primaryProviderFailures: [],
    primaryControlFailures: [],
    fallback: null,
    fallbackProviderFailures: [],
    fallbackControlFailures: [],
  }
  try {
    evidence.primary = await runSurfaceAttempt({
      selection,
      visibility,
      homeDir,
      temporaryRoot,
    })
    evidence.primaryProviderFailures = providerSurfaceFailures(evidence.primary)
    evidence.primaryControlFailures = googleControlFailures(evidence.primary)
    if (evidence.primaryProviderFailures.length > 0 && fallbackSelection !== null) {
      evidence.fallback = await runSurfaceAttempt({
        selection: fallbackSelection,
        visibility,
        homeDir,
        temporaryRoot,
      })
      evidence.fallbackProviderFailures = providerSurfaceFailures(evidence.fallback)
      evidence.fallbackControlFailures = googleControlFailures(evidence.fallback)
    }
    const reportPath = await writeEvidence(evidence)
    console.log(`Browser surface evidence: ${reportPath}`)
    console.log(JSON.stringify(evidence, null, 2))
    if (fallbackSelection === null) {
      assert.deepEqual([
        ...evidence.primaryProviderFailures,
        ...evidence.primaryControlFailures,
      ], [])
      return
    }
    assert.ok(
      evidence.primaryProviderFailures.length > 0,
      'Explicit browser fallback gate did not observe a primary provider failure.',
    )
    assert.ok(evidence.fallback, 'Fallback browser attempt was not recorded.')
    assert.deepEqual(evidence.fallbackProviderFailures, [])
  } finally {
    if (ownsHome) await fs.rm(homeDir, { recursive: true, force: true })
  }
})

async function runSurfaceAttempt({ selection, visibility, homeDir, temporaryRoot }) {
  const profileDir = await fs.mkdtemp(path.join(temporaryRoot, `tokenless-browser-surface-${selection}-profile-`))
  const runtime = await new BrowserRuntimeManager({ homeDir }).ensure(selection, { allowDownload: true })
  if (runtime.managed) assert.equal(runtime.actualVersion, runtime.expectedVersion)
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: runtime.executablePath,
    headless: visibility === 'headless',
    chromiumSandbox: true,
    args: [
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ...(runtime.launchPolicy === 'cloak'
      ? { ignoreDefaultArgs: ['--enable-automation', '--enable-unsafe-swiftshader'] }
      : {}),
  })
  const attempt = {
    selection,
    runtimeId: runtime.runtimeId,
    family: runtime.family,
    actualVersion: runtime.actualVersion,
    executablePath: runtime.executablePath,
    providers: [],
    google: null,
  }
  try {
    const page = context.pages()[0] ?? await context.newPage()
    for (const descriptor of listProviderDescriptors().filter((candidate) => candidate.stage !== 'disabled')) {
      const result = await visitSurface(page, descriptor.navigation.homeUrl)
      attempt.providers.push({
        provider: descriptor.id === 'grok' ? 'grok-cloud' : descriptor.id,
        ...result,
      })
    }
    const googleTarget = new URL('https://www.google.com/search')
    googleTarget.searchParams.set('q', 'OpenAI API documentation')
    attempt.google = await visitGoogle(page, googleTarget.toString())
    return attempt
  } finally {
    await context.close().catch(() => undefined)
    await fs.rm(profileDir, { recursive: true, force: true })
  }
}

async function writeEvidence(evidence) {
  const reportDirectory = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'test-results', 'live-browser-surfaces')
  await fs.mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  const timestamp = evidence.observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  const suffix = fallbackSelection === null ? '' : `-fallback-${fallbackSelection}`
  const reportPath = path.join(reportDirectory, `${timestamp}-${selection}-${visibility}${suffix}.json`)
  await fs.writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  return reportPath
}

function providerSurfaceFailures(evidence) {
  const failures = []
  for (const provider of evidence.providers) {
    if (provider.navigationError) {
      failures.push(`${provider.provider} navigation failed: ${provider.navigationError}`)
    }
    if (provider.httpStatus !== null && provider.httpStatus >= 400) {
      failures.push(`${provider.provider} returned HTTP ${provider.httpStatus}.`)
    }
    if (provider.challenge) {
      failures.push(`${provider.provider} showed ${provider.challenge.code}.`)
    }
  }
  return failures
}

function googleControlFailures(evidence) {
  const failures = []
  if (evidence.google.navigationError) {
    failures.push(`Google navigation failed: ${evidence.google.navigationError}`)
  }
  if (evidence.google.httpStatus !== null && evidence.google.httpStatus >= 400) {
    failures.push(`Google returned HTTP ${evidence.google.httpStatus}.`)
  }
  if (evidence.google.captchaTriggered) {
    failures.push(`Google showed ${evidence.google.challenge?.code ?? 'a CAPTCHA'}.`)
  }
  if (!evidence.google.resultsVisible && evidence.google.challenge?.family !== 'consent') {
    failures.push('Google neither rendered search results nor a normal consent surface.')
  }
  return failures
}

async function visitSurface(page, targetUrl) {
  let response = null
  let navigationError = null
  try {
    response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error)
  }
  await page.waitForTimeout(2_000)
  const finalUrl = publicLocation(page.url())
  const title = await page.title().catch(() => '')
  const requestedOrigin = new URL(targetUrl).origin
  const challenge = navigationError && finalUrl.origin !== requestedOrigin
    ? null
    : await visibleChallenge(page, title)
  return {
    requestedOrigin,
    httpStatus: response?.status() ?? null,
    finalOrigin: finalUrl.origin,
    finalPath: finalUrl.pathname,
    title,
    challenge,
    navigationError,
  }
}

async function visitGoogle(page, targetUrl) {
  const surface = await visitSurface(page, targetUrl)
  const challenge = await googleChallenge(page)
  return {
    ...surface,
    challenge,
    resultsVisible: challenge === null && await anyVisible(page, ['#search', '#rso', 'a h3']),
    captchaTriggered: challenge?.family === 'recaptcha',
  }
}

async function googleChallenge(page) {
  if (page.url().includes('/sorry/')) return { family: 'recaptcha', code: 'google_sorry_url' }
  if (await anyVisible(page, [
    'iframe[src*="recaptcha"]',
    'form#captcha-form',
    '.g-recaptcha',
    'text=/our systems have detected unusual traffic/i',
  ])) return { family: 'recaptcha', code: 'visible_google_recaptcha' }
  if (await anyVisible(page, [
    'text=/before you continue to google/i',
    'form[action*="consent.google"]',
  ])) return { family: 'consent', code: 'visible_google_consent' }
  return null
}

async function visibleChallenge(page, title) {
  if (/just a moment|checking your browser/i.test(title)) {
    return { family: 'cloudflare', code: 'cloudflare_interstitial_title' }
  }
  if (/human verification|security verification|captcha/i.test(title)) {
    return { family: 'bot_verification', code: 'visible_verification_title' }
  }
  if (await anyVisible(page, [
    'iframe[src*="recaptcha"]',
    '.g-recaptcha',
    '[aria-label*="captcha" i]',
  ])) return { family: 'recaptcha', code: 'visible_recaptcha' }
  if (await anyVisible(page, [
    'iframe[src*="challenges.cloudflare.com"]',
    'input[name="cf-turnstile-response"]',
    '#challenge-running',
  ])) return { family: 'cloudflare', code: 'visible_cloudflare_challenge' }
  if (await anyVisible(page, ['iframe[src*="hcaptcha.com"]', '.h-captcha'])) {
    return { family: 'hcaptcha', code: 'visible_hcaptcha' }
  }
  return null
}

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true
  }
  return false
}

function publicLocation(value) {
  try {
    const parsed = new URL(value)
    return { origin: parsed.origin, pathname: parsed.pathname }
  } catch {
    return { origin: '', pathname: '' }
  }
}
