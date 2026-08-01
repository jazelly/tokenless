#!/usr/bin/env node
/**
 * PROTOTYPE — delete after the Chrome-to-Cloak profile question is answered.
 *
 * Question: can CloakBrowser 145 open a complete profile directory produced by
 * the installed Chrome 150? If Chromium's downgrade guard rejects a raw copy,
 * does removing only the copied profile's top-level `Last Version` marker make
 * its synthetic cookie/localStorage data usable and durable?
 */

import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const artifactRoot = path.join(root, 'test-results', 'cloakbrowser-profile-compat')
const runtimeCache = path.join(root, 'test-results', 'cloakbrowser-spike', 'runtime-cache')
const chromeProfile = path.join(artifactRoot, 'chrome-150-source')
const directProfile = path.join(artifactRoot, 'cloak-145-direct-copy')
const normalizedProfile = path.join(artifactRoot, 'cloak-145-normalized-copy')
const migratedSwitchProfile = path.join(artifactRoot, 'cloak-145-migrated-switch-copy')
const cloakSeedProfile = path.join(artifactRoot, 'cloak-145-seed')
const chromeDefaultProfile = path.join(artifactRoot, 'cloak-145-chrome-default-copy')
const selectedStorageProfile = path.join(artifactRoot, 'cloak-145-selected-storage-copy')
const resultFile = path.join(artifactRoot, 'last-run.json')
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const cloakVersion = '145.0.7632.109.2'
const wrapperVersion = '0.5.3'
const observeMs = parseDurationArg(process.argv.slice(2), '--observe-ms=')
const sourceMarker = `TOKENLESS_CHROME150_PROFILE_${Date.now()}`
const cloakMarker = `TOKENLESS_CLOAK145_WRITE_${Date.now()}`

const state = {
  prototype: 'cloakbrowser-profile-compat',
  chromeVersion: null,
  cloakVersion,
  cloakLaunchVersion: null,
  sourceProfileCreated: false,
  sourceLastVersion: null,
  sourceProfileLayout: {
    root: [],
    default: [],
  },
  standardProfileEntries: {},
  directCopy: {
    opened: false,
    launchFailure: null,
  },
  normalizedCopy: {
    conversion: 'remove copied top-level Last Version marker only',
    lastVersionRemoved: false,
    opened: false,
    sourceCookiePreserved: false,
    sourceLocalStoragePreserved: false,
    cloakWritePersistedAfterRestart: false,
  },
  migratedSwitchCopy: {
    conversion: 'keep raw copy and pass --user-data-migrated',
    opened: false,
    launchFailure: null,
  },
  cloakRootChromeDefaultCopy: {
    conversion: 'keep Cloak 145 root metadata and replace Default with Chrome 150 Default',
    opened: false,
    launchFailure: null,
  },
  selectedStorageCopy: {
    conversion: 'keep Cloak 145 profile and replace only Local Storage plus the synthetic cookie database',
    opened: false,
    sourceCookiePreserved: false,
    sourceLocalStoragePreserved: false,
    importedStatePersistedAfterRestart: false,
    launchFailure: null,
  },
  directObservation: null,
  status: 'starting',
  error: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
}

const safeArgs = [
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
]

try {
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await cleanupProfiles()
  state.chromeVersion = (await execFileAsync(chromeExecutable, ['--version'])).stdout.trim()
  render('chrome-source', 'Create a credential-free synthetic profile with the installed Chrome.')

  const chromeContext = await chromium.launchPersistentContext(chromeProfile, {
    executablePath: chromeExecutable,
    headless: false,
    chromiumSandbox: true,
    args: safeArgs,
  })
  try {
    const page = chromeContext.pages()[0] ?? await chromeContext.newPage()
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await chromeContext.addCookies([{
      name: 'tokenless_profile_probe',
      value: sourceMarker,
      domain: 'example.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86_400,
      secure: true,
      sameSite: 'Lax',
    }])
    await page.evaluate((marker) => localStorage.setItem('tokenless-profile-probe', marker), sourceMarker)
    state.sourceProfileCreated = true
  } finally {
    await chromeContext.close()
  }

  state.sourceLastVersion = await readOptionalText(path.join(chromeProfile, 'Last Version'))
  state.sourceProfileLayout = {
    root: await listEntryNames(chromeProfile),
    default: await listEntryNames(path.join(chromeProfile, 'Default')),
  }
  state.standardProfileEntries = await inspectStandardProfileEntries(chromeProfile)
  const cloakExecutable = await resolveCloakExecutable()
  state.cloakLaunchVersion = (await execFileAsync(cloakExecutable, ['--version'])).stdout.trim()

  render('direct-copy', 'Try the complete Chrome 150 profile copy without conversion.')
  await copyProfile(chromeProfile, directProfile)
  try {
    const directContext = await launchCloakProfile(cloakExecutable, directProfile, false)
    state.directCopy.opened = true
    await directContext.close()
  } catch (error) {
    state.directCopy.launchFailure = summarizeLaunchFailure(error)
  }

  render('normalize-copy', 'Copy again and remove only Chromium\'s top-level downgrade marker.')
  await copyProfile(chromeProfile, normalizedProfile)
  const normalizedLastVersion = path.join(normalizedProfile, 'Last Version')
  state.normalizedCopy.lastVersionRemoved = await removeIfPresent(normalizedLastVersion)
  if (!state.normalizedCopy.lastVersionRemoved) {
    throw new Error('The Chrome source did not produce the expected top-level Last Version marker.')
  }

  render('cloak-open', 'Open the minimally normalized Chrome 150 profile with CloakBrowser 145.')
  try {
    const cloakContext = await launchCloakProfile(cloakExecutable, normalizedProfile, false)
    state.normalizedCopy.opened = true
    await cloakContext.close()
  } catch (error) {
    state.normalizedCopy.launchFailure = summarizeLaunchFailure(error)
  }

  render('migrated-switch', 'Keep the raw copy and ask Chromium to bypass downgrade processing explicitly.')
  await copyProfile(chromeProfile, migratedSwitchProfile)
  try {
    const context = await launchCloakProfile(
      cloakExecutable,
      migratedSwitchProfile,
      false,
      ['--user-data-migrated'],
    )
    state.migratedSwitchCopy.opened = true
    await context.close()
  } catch (error) {
    state.migratedSwitchCopy.launchFailure = summarizeLaunchFailure(error)
  }

  render('cloak-seed', 'Create Cloak 145 root metadata before transplanting Chrome profile-level data.')
  const seedContext = await launchCloakProfile(cloakExecutable, cloakSeedProfile, true)
  await seedContext.close()

  await copyProfile(cloakSeedProfile, chromeDefaultProfile)
  await fs.rm(path.join(chromeDefaultProfile, 'Default'), { recursive: true, force: true })
  await fs.cp(path.join(chromeProfile, 'Default'), path.join(chromeDefaultProfile, 'Default'), {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  })
  render('chrome-default', 'Keep the Cloak root and test the complete Chrome Default profile payload.')
  try {
    const context = await launchCloakProfile(cloakExecutable, chromeDefaultProfile, false)
    state.cloakRootChromeDefaultCopy.opened = true
    await context.close()
  } catch (error) {
    state.cloakRootChromeDefaultCopy.launchFailure = summarizeLaunchFailure(error)
  }

  await copyProfile(cloakSeedProfile, selectedStorageProfile)
  await replaceEntry(
    path.join(chromeProfile, 'Default', 'Local Storage'),
    path.join(selectedStorageProfile, 'Default', 'Local Storage'),
  )
  const sourceCookieDatabase = await findCookieDatabase(chromeProfile)
  if (sourceCookieDatabase) {
    const relativeCookieDatabase = path.relative(chromeProfile, sourceCookieDatabase)
    await replaceEntry(
      sourceCookieDatabase,
      path.join(selectedStorageProfile, relativeCookieDatabase),
    )
  }
  render('selected-storage', 'Test only synthetic web storage on top of a Cloak-owned profile.')
  let selectedContext = null
  try {
    selectedContext = await launchCloakProfile(cloakExecutable, selectedStorageProfile, false)
    const page = selectedContext.pages()[0] ?? await selectedContext.newPage()
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const cookies = await selectedContext.cookies('https://example.com/')
    state.selectedStorageCopy.sourceCookiePreserved = cookies.some((cookie) => (
      cookie.name === 'tokenless_profile_probe' && cookie.value === sourceMarker
    ))
    state.selectedStorageCopy.sourceLocalStoragePreserved = await page.evaluate(
      () => localStorage.getItem('tokenless-profile-probe'),
    ) === sourceMarker
    state.selectedStorageCopy.opened = true
    if (observeMs > 0) {
      state.directObservation = {
        requestedMs: observeMs,
        status: 'available',
        observer: 'macOS accessibility and process inspection only',
        externalCdpAttach: false,
      }
      render('observing', `The Cloak-owned selected-storage profile will remain open for ${observeMs}ms.`)
      await delay(observeMs)
      state.directObservation.status = 'completed'
    }
  } catch (error) {
    state.selectedStorageCopy.launchFailure = summarizeLaunchFailure(error)
  } finally {
    await selectedContext?.close().catch(() => undefined)
  }

  if (state.selectedStorageCopy.opened) {
    render('selected-storage-reopen', 'Reopen the converted profile and verify imported state durability.')
    const reopenedContext = await launchCloakProfile(cloakExecutable, selectedStorageProfile, true)
    try {
      const page = reopenedContext.pages()[0] ?? await reopenedContext.newPage()
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 120_000 })
      const cookies = await reopenedContext.cookies('https://example.com/')
      const cookiePersisted = cookies.some((cookie) => (
        cookie.name === 'tokenless_profile_probe' && cookie.value === sourceMarker
      ))
      const localStoragePersisted = await page.evaluate(
        () => localStorage.getItem('tokenless-profile-probe'),
      ) === sourceMarker
      state.selectedStorageCopy.importedStatePersistedAfterRestart = (
        cookiePersisted && localStoragePersisted
      )
    } finally {
      await reopenedContext.close()
    }
  }

  state.status = state.selectedStorageCopy.importedStatePersistedAfterRestart
    ? 'passed-partial'
    : 'failed'
  render(
    state.status,
    state.selectedStorageCopy.importedStatePersistedAfterRestart
      ? 'A Cloak-owned profile accepted selected Chrome web-storage data across restart; complete-profile compatibility still failed.'
      : 'All complete-profile and selected-storage compatibility candidates failed to open.',
  )
} catch (error) {
  state.status = 'failed'
  state.error = summarizeLaunchFailure(error)
  render('failed', state.error)
  process.exitCode = 1
} finally {
  await cleanupProfiles().catch(() => undefined)
  state.finishedAt = new Date().toISOString()
  await fs.mkdir(artifactRoot, { recursive: true, mode: 0o700 })
  await fs.writeFile(resultFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  console.log(`\nPrototype result: ${resultFile}`)
}

async function resolveCloakExecutable() {
  const env = {
    ...process.env,
    CLOAKBROWSER_AUTO_UPDATE: 'false',
    CLOAKBROWSER_CACHE_DIR: runtimeCache,
    CLOAKBROWSER_LICENSE_KEY: '',
    CLOAKBROWSER_VERSION: cloakVersion,
  }
  await execFileAsync('npm', [
    'exec', '--yes', `--package=cloakbrowser@${wrapperVersion}`, '--',
    'cloakbrowser', 'install',
  ], { cwd: root, env })
  const diagnostics = await execFileAsync('npm', [
    'exec', '--yes', `--package=cloakbrowser@${wrapperVersion}`, '--',
    'cloakbrowser', 'info', '--quick', '--json',
  ], { cwd: root, env })
  const info = JSON.parse(diagnostics.stdout.slice(
    diagnostics.stdout.indexOf('{'),
    diagnostics.stdout.lastIndexOf('}') + 1,
  ))
  if (info?.binary?.version !== cloakVersion || info?.binary?.tier !== 'free') {
    throw new Error(`Unexpected CloakBrowser diagnostics: ${JSON.stringify(info?.binary ?? null)}`)
  }
  await fs.access(info.binary.path, fsConstants.X_OK)
  return info.binary.path
}

async function launchCloakProfile(executablePath, userDataDir, headless, extraArgs = []) {
  return chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless,
    chromiumSandbox: true,
    args: [...safeArgs, ...extraArgs],
  })
}

async function copyProfile(source, target) {
  await fs.cp(source, target, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  })
}

async function inspectStandardProfileEntries(userDataDir) {
  const entries = [
    'Last Version',
    'Local State',
    'Default/Preferences',
    'Default/History',
    'Default/Cookies',
    'Default/Network/Cookies',
    'Default/Local Storage',
    'Default/Sessions',
  ]
  return Object.fromEntries(await Promise.all(entries.map(async (entry) => {
    try {
      await fs.access(path.join(userDataDir, entry))
      return [entry, true]
    } catch {
      return [entry, false]
    }
  })))
}

async function listEntryNames(directory) {
  return (await fs.readdir(directory)).sort()
}

async function findCookieDatabase(userDataDir) {
  for (const relativePath of ['Default/Cookies', 'Default/Network/Cookies']) {
    const candidate = path.join(userDataDir, relativePath)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // Continue to the next version-dependent location.
    }
  }
  return null
}

async function replaceEntry(source, target) {
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await fs.cp(source, target, {
    recursive: true,
    errorOnExist: true,
    preserveTimestamps: true,
  })
}

async function readOptionalText(filePath) {
  try {
    return (await fs.readFile(filePath, 'utf8')).trim()
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function removeIfPresent(filePath) {
  try {
    await fs.rm(filePath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function summarizeLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n', 1)[0]
  const signal = message.match(/signal=(SIG[A-Z]+)/)?.[1] ?? null
  return { message: firstLine, signal }
}

async function cleanupProfiles() {
  await fs.rm(chromeProfile, { recursive: true, force: true })
  await fs.rm(directProfile, { recursive: true, force: true })
  await fs.rm(normalizedProfile, { recursive: true, force: true })
  await fs.rm(migratedSwitchProfile, { recursive: true, force: true })
  await fs.rm(cloakSeedProfile, { recursive: true, force: true })
  await fs.rm(chromeDefaultProfile, { recursive: true, force: true })
  await fs.rm(selectedStorageProfile, { recursive: true, force: true })
}

function parseDurationArg(args, prefix) {
  const entry = args.find((value) => value.startsWith(prefix))
  if (!entry) return 0
  const value = Number(entry.slice(prefix.length))
  if (!Number.isInteger(value) || value < 0 || value > 600_000) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer from 0 through 600000.`)
  }
  return value
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function render(status, message) {
  state.status = status
  console.log(`\n[CloakBrowser profile compat] ${status}`)
  console.log(message)
  console.log(JSON.stringify(state, null, 2))
}
