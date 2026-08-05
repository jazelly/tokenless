import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BrowserRuntimeManager,
  normalizeBrowserSelection,
  readTokenlessConfig,
} from '../../packages/cli/dist/src/index.js'
import { ManagedProfileRegistry } from '../../packages/cli/dist/src/playwright/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

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
  env = process.env,
} = {}) {
  const requestedBrowser = nonempty(browser) ?? nonempty(env.TOKENLESS_LIVE_PROVIDER_TEST_BROWSER)
  if (!requestedBrowser) {
    throw new Error(
      `Live provider E2E requires --browser <${LIVE_PROVIDER_TEST_BROWSERS.join('|')}>.`,
    )
  }

  const browserSelection = normalizeBrowserSelection(requestedBrowser)
  if (!browserSelection || !LIVE_PROVIDER_TEST_BROWSERS.includes(browserSelection)) {
    throw new Error(
      `Live provider E2E requires one explicit browser: ${LIVE_PROVIDER_TEST_BROWSERS.join(', ')}.`,
    )
  }

  const baseHome = path.resolve(nonempty(env.TOKENLESS_HOME) ?? path.join(os.homedir(), '.tokenless'))
  const homeDir = path.resolve(
    nonempty(home) ??
    nonempty(env.TOKENLESS_LIVE_PROVIDER_TEST_HOME) ??
    path.join(baseHome, 'e2e', 'live-provider'),
  )
  if (homeDir === baseHome) {
    throw new Error('Live provider E2E home must not be the ordinary Tokenless home.')
  }
  if (isWithin(repositoryRoot, homeDir)) {
    throw new Error('Live provider E2E home must remain outside the repository and its worktrees.')
  }
  return Object.freeze({
    homeDir,
    ordinaryHome: baseHome,
    profileSlug: `live-provider-${browserSelection}`,
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
      `Dedicated live provider profile '${profile.slug}' resolves outside its test-only profile root.`,
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

function assertTestOnlyHome(homeDir, ordinaryHome) {
  if (homeDir === ordinaryHome) {
    throw new Error('Live provider E2E home must not be the ordinary Tokenless home.')
  }
  if (isWithin(repositoryRoot, homeDir)) {
    throw new Error('Live provider E2E home must remain outside the repository and its worktrees.')
  }
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
