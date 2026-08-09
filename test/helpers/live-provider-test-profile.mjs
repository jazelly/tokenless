import fs, { constants as fsConstants } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  BrowserRuntimeManager,
  normalizeBrowserSelection,
  readTokenlessConfig,
} from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry } from '../../packages/cli/dist/src/playwright/index.js'
import { PersistentContextManager } from '../../packages/cli/dist/src/playwright/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localEnvironmentFile = path.join(repositoryRoot, '.env')

try {
  await fs.access(localEnvironmentFile, fsConstants.R_OK)
  process.loadEnvFile(localEnvironmentFile)
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

export const LIVE_PROVIDER_TEST_BROWSERS = Object.freeze([
  'chrome',
  'edge',
  'chromium',
  'chrome-for-testing',
  'managed-chromium',
  'cloak',
])

export function resolveLiveProviderTestTarget({
  browser,
  home,
  profile,
  env = process.env,
} = {}) {
  const requestedBrowser = nonempty(browser)
  if (!requestedBrowser) {
    throw new Error(
      `Profile preparation requires --browser <${LIVE_PROVIDER_TEST_BROWSERS.join('|')}>.`,
    )
  }

  const browserSelection = normalizeBrowserSelection(requestedBrowser)
  if (!browserSelection || !LIVE_PROVIDER_TEST_BROWSERS.includes(browserSelection)) {
    throw new Error(
      `Live provider E2E requires one explicit browser: ${LIVE_PROVIDER_TEST_BROWSERS.join(', ')}.`,
    )
  }

  const requestedHome = nonempty(home)
  if (!requestedHome) {
    throw new Error('Profile preparation requires --home.')
  }
  const profileSlug = nonempty(profile)
  if (!profileSlug) {
    throw new Error('Profile preparation requires --profile.')
  }
  const baseHome = path.resolve(nonempty(env.TOKENLESS_HOME) ?? path.join(os.homedir(), '.tokenless'))
  const homeDir = path.resolve(requestedHome)
  if (isWithin(repositoryRoot, homeDir)) {
    throw new Error('Live provider E2E home must remain outside the repository and its worktrees.')
  }
  return Object.freeze({
    homeDir,
    ordinaryHome: baseHome,
    profileSlug,
    browserSelection,
    source: 'browser-selection',
  })
}

export async function canonicalizeLiveProviderTestTarget(target) {
  const homeDir = await fs.realpath(target.homeDir)
  const ordinaryHome = await fs.realpath(target.ordinaryHome).catch((error) => {
    if (error?.code === 'ENOENT') return path.resolve(target.ordinaryHome)
    throw error
  })
  assertTestOnlyHome(homeDir, ordinaryHome)
  return Object.freeze({ ...target, homeDir, ordinaryHome })
}

export async function validateLiveProviderTestTarget(target) {
  let canonicalTarget
  try {
    canonicalTarget = await canonicalizeLiveProviderTestTarget(target)
  } catch (error) {
    if (error?.code === 'ENOENT') throw profileNotPreparedError(target, error)
    throw error
  }
  const registry = new ManagedProfileRegistry(canonicalTarget.homeDir)
  let profile
  try {
    profile = await registry.resolveProfile(canonicalTarget.profileSlug)
  } catch (error) {
    if (error?.code === 'profile_not_found' || error?.code === 'profile_not_configured') {
      throw profileNotPreparedError(canonicalTarget, error)
    }
    throw error
  }
  if (profile.lifecycle !== 'ready') {
    throw new Error(
      `Dedicated live provider profile '${profile.slug}' is ${profile.lifecycle}; it must be ready before automation.`,
    )
  }

  const profilesRoot = await fs.realpath(registry.paths.profilesRoot)
  const profileDirectory = await fs.realpath(profile.directory)
  const relativeDirectory = path.relative(profilesRoot, profileDirectory)
  if (
    !relativeDirectory ||
    path.isAbsolute(relativeDirectory) ||
    relativeDirectory === '..' ||
    relativeDirectory.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Dedicated live provider profile '${profile.slug}' resolves outside its configured profile root.`,
    )
  }

  if (process.platform !== 'win32') {
    const metadata = await fs.stat(profileDirectory)
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(
        `Dedicated live provider profile '${profile.slug}' must not grant group or other filesystem access.`,
      )
    }
  }

  const config = await readTokenlessConfig(canonicalTarget.homeDir)
  const runtime = await new BrowserRuntimeManager({ homeDir: canonicalTarget.homeDir }).resolveForProfile(profile, {
    browserExecutablePath: profile.runtimeBinding?.browserId === config.browser
      ? config.browserExecutablePath
      : null,
  })
  if (canonicalTarget.browserSelection && runtime.selection !== canonicalTarget.browserSelection) {
    throw new Error(
      `Dedicated live provider profile '${profile.slug}' is bound to ${runtime.selection}, ` +
      `not requested browser ${canonicalTarget.browserSelection}.`,
    )
  }

  return Object.freeze({
    ...canonicalTarget,
    profile,
    runtime,
    relativeDirectory,
  })
}

export async function resolveDedicatedTestConfig({ env = process.env } = {}) {
  const configuredPath = nonempty(env.TOKENLESS_TEST_CONFIG)
  if (!configuredPath) {
    throw new Error('Browser tests require TOKENLESS_TEST_CONFIG in the repository .env file.')
  }
  const configPath = await fs.realpath(path.resolve(configuredPath))
  if (path.basename(configPath) !== 'config.json') {
    throw new Error('TOKENLESS_TEST_CONFIG must point to a Tokenless config.json file.')
  }
  const homeDir = path.dirname(configPath)
  const ordinaryHome = await canonicalizeHome(
    nonempty(env.TOKENLESS_HOME) ?? path.join(os.homedir(), '.tokenless'),
  )
  assertTestOnlyHome(homeDir, ordinaryHome)
  const config = await readTokenlessConfig(homeDir)
  const registry = new ManagedProfileRegistry(homeDir)
  const defaultProfile = await registry.resolveProfile()
  return Object.freeze({ configPath, homeDir, ordinaryHome, config, defaultProfile })
}

export async function resolveConfiguredDedicatedTestTarget({ env = process.env } = {}) {
  const configured = await resolveDedicatedTestConfig({ env })
  const profile = configured.defaultProfile
  return await validateLiveProviderTestTarget(resolveLiveProviderTestTarget({
    browser: profile.runtimeBinding?.browserId ?? configured.config.browser,
    home: configured.homeDir,
    profile: profile.slug,
    env,
  }))
}

export function createLiveProviderTestContextManager(target) {
  if (!target?.profile || !target?.runtime) {
    throw new Error('A validated dedicated live provider profile is required before browser automation.')
  }
  return new PersistentContextManager({
    maxContexts: 1,
    browser: {
      id: target.runtime.browserId,
      executablePath: target.runtime.executablePath,
      runtimeId: target.runtime.runtimeId,
      launchPolicy: target.runtime.launchPolicy,
    },
  })
}

export async function withDedicatedTestBrowser(operation, options = {}) {
  const target = await resolveConfiguredDedicatedTestTarget(options)
  const manager = createLiveProviderTestContextManager(target)
  try {
    return await manager.runWithProfile(target.profile, options.visibility ?? 'auto', async (context) => (
      await operation({ context, target })
    ))
  } finally {
    await manager.detach()
  }
}

export async function withDedicatedTestPage(operation, options = {}) {
  return await withDedicatedTestBrowser(async ({ context, target }) => {
    const page = await context.browserContext.newPage()
    try {
      if (options.viewport) await page.setViewportSize(options.viewport)
      return await operation({ page, context, target })
    } finally {
      await page.close().catch(() => undefined)
    }
  }, options)
}

function assertTestOnlyHome(homeDir, ordinaryHome) {
  if (isWithin(repositoryRoot, homeDir)) {
    throw new Error('Live provider E2E home must remain outside the repository and its worktrees.')
  }
  if (ordinaryHome && (isWithin(homeDir, ordinaryHome) || isWithin(ordinaryHome, homeDir))) {
    throw new Error('TOKENLESS_TEST_CONFIG must use a dedicated test home that does not overlap TOKENLESS_HOME.')
  }
}

async function canonicalizeHome(homeDir) {
  return await fs.realpath(path.resolve(homeDir)).catch((error) => {
    if (error?.code === 'ENOENT') return path.resolve(homeDir)
    throw error
  })
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function profileNotPreparedError(target, cause) {
  return new Error(
    `Dedicated live provider profile '${target.profileSlug}' is not prepared under ${target.homeDir}. ` +
    'Run the live provider E2E prepare command before automation.',
    { cause },
  )
}

function nonempty(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}
