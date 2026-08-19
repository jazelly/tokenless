import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

import {
  BrowserRuntimeManager,
  readTokenlessConfig,
} from '../../packages/cli/dist/src/index.js'
import {
  ManagedProfileRegistry,
  PersistentContextManager,
} from '../../packages/server/dist/src/browser/index.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryEnvironmentFile = path.join(repositoryRoot, '.env')

export async function resolveTestConfig() {
  let repositoryEnvironment
  try {
    repositoryEnvironment = parseEnv(await fs.readFile(repositoryEnvironmentFile, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Browser tests require repository .env with TOKENLESS_TEST_CONFIG.')
    }
    throw error
  }
  const configuredPath = nonempty(repositoryEnvironment.TOKENLESS_TEST_CONFIG)
  if (!configuredPath) throw new Error('Browser tests require TOKENLESS_TEST_CONFIG in the repository .env file.')
  const configPath = await fs.realpath(path.resolve(repositoryRoot, configuredPath))
  if (path.basename(configPath) !== 'config.json') {
    throw new Error('TOKENLESS_TEST_CONFIG must point to a Tokenless config.json file.')
  }
  const homeDir = path.dirname(configPath)
  assertOutsideRepository(homeDir)
  const config = await readTokenlessConfig(homeDir)
  const registry = new ManagedProfileRegistry(homeDir)
  const profile = await registry.resolveProfile()
  return Object.freeze({ configPath, homeDir, config, registry, profile })
}

export async function resolveConfiguredBrowserTarget() {
  const configured = await resolveTestConfig()
  const { homeDir, config, registry, profile } = configured
  if (profile.lifecycle !== 'ready') {
    throw new Error(`Configured browser profile '${profile.slug}' is ${profile.lifecycle}; it must be ready before automation.`)
  }
  const profilesRoot = await fs.realpath(registry.paths.profilesRoot)
  const profileDirectory = await fs.realpath(profile.directory)
  const relativeDirectory = path.relative(profilesRoot, profileDirectory)
  if (!relativeDirectory || path.isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${path.sep}`)) {
    throw new Error(`Configured browser profile '${profile.slug}' resolves outside its configured profile root.`)
  }
  if (process.platform !== 'win32') {
    const metadata = await fs.stat(profileDirectory)
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error(`Configured browser profile '${profile.slug}' must not grant group or other filesystem access.`)
    }
  }
  const runtimeManager = new BrowserRuntimeManager({ homeDir })
  const runtime = profile.runtimeBinding
    ? await runtimeManager.resolveForProfile(profile, {
        browserExecutablePath: profile.runtimeBinding.browserId === config.browser ? config.browserExecutablePath : null,
      })
    : await resolveNativeRuntime(runtimeManager, config)
  if (profile.runtimeBinding && (
    runtime.browserId !== profile.runtimeBinding.browserId || runtime.runtimeId !== profile.runtimeBinding.runtimeId
  )) throw new Error(`Configured browser profile '${profile.slug}' did not resolve its bound runtime.`)
  return Object.freeze({ configPath: configured.configPath, homeDir, config, profile, runtime, relativeDirectory })
}

export function createConfiguredBrowserContextManager(target) {
  if (!target?.profile || !target?.runtime) throw new Error('A configured browser profile is required before browser automation.')
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

export async function withConfiguredBrowser(operation, options = {}) {
  const target = await resolveConfiguredBrowserTarget()
  const manager = createConfiguredBrowserContextManager(target)
  try {
    return await manager.runWithProfile(target.profile, options.visibility ?? 'auto', async (context) => (
      await operation({ context, target })
    ))
  } finally {
    await manager.detach()
  }
}

export async function withConfiguredBrowserPage(operation, options = {}) {
  return await withConfiguredBrowser(async ({ context, target }) => {
    const page = await context.browserContext.newPage()
    return await operation({ page, context, target })
  }, options)
}

async function resolveNativeRuntime(runtimeManager, config) {
  const browserId = config.browser === 'brave' ? 'brave' : 'chrome'
  const resolved = await runtimeManager.ensure(browserId, {
    allowDownload: false,
    browserExecutablePath: config.browserExecutablePath,
  })
  return Object.freeze({
    ...resolved,
    selection: browserId,
    browserId,
    runtimeId: `native:${browserId}`,
    family: 'system',
    launchPolicy: 'native',
  })
}

function assertOutsideRepository(homeDir) {
  if (isWithin(repositoryRoot, homeDir)) {
    throw new Error('TOKENLESS_TEST_CONFIG must point outside the repository and its worktrees.')
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

function nonempty(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}
