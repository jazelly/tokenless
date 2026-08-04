import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
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
if (!['auto', 'managed-chromium', 'cloak'].includes(selection)) {
  throw new Error('Set TOKENLESS_LIVE_BROWSER_SURFACE_SELECTION to auto, managed-chromium, or cloak.')
}

test(`${selection} reaches every provider surface and Google Search without a detected anti-bot challenge`, { timeout: 20 * 60_000 }, async () => {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const suppliedHome = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_HOME
  const homeDir = suppliedHome
    ? path.resolve(suppliedHome)
    : await fs.mkdtemp(path.join(temporaryRoot, 'tokenless-browser-surface-home-'))
  const ownsHome = !suppliedHome
  const profileDir = await fs.mkdtemp(path.join(temporaryRoot, 'tokenless-browser-surface-profile-'))
  const runtime = await new BrowserRuntimeManager({ homeDir }).ensure(selection, { allowDownload: true })
  if (runtime.managed) assert.equal(runtime.actualVersion, runtime.expectedVersion)

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: runtime.executablePath,
    headless: false,
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
  const evidence = {
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
      evidence.providers.push({
        provider: descriptor.id === 'grok' ? 'grok-cloud' : descriptor.id,
        ...result,
      })
    }

    const googleTarget = new URL('https://www.google.com/search')
    googleTarget.searchParams.set('q', 'OpenAI API documentation')
    evidence.google = await visitGoogle(page, googleTarget.toString())
    console.log(JSON.stringify(evidence, null, 2))
    assert.deepEqual(surfaceFailures(evidence), [])
  } finally {
    await context.close().catch(() => undefined)
    await fs.rm(profileDir, { recursive: true, force: true })
    if (ownsHome) await fs.rm(homeDir, { recursive: true, force: true })
  }
})

function surfaceFailures(evidence) {
  const failures = []
  for (const provider of evidence.providers) {
    if (provider.navigationError) {
      failures.push(`${provider.provider} navigation failed: ${provider.navigationError}`)
    }
    if (provider.challenge) {
      failures.push(`${provider.provider} showed ${provider.challenge.code}.`)
    }
  }
  if (evidence.google.navigationError) {
    failures.push(`Google navigation failed: ${evidence.google.navigationError}`)
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
