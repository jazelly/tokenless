import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { TokenlessLanguage } from './localization.js'

export { tokenlessHome } from './bootstrap/home.js'

export {
  DEFAULT_DAEMON_URL,
  MAX_DAEMON_REQUEST_BYTES,
  browserRuntimeStatus,
  cancelDaemonJob,
  createDaemonJob,
  daemonUrl,
  getDaemonJob,
  generateImage,
  getProviderCapacity,
  getControlState,
  getControlCapabilities,
  listDaemonJobs,
  openBrowserRuntimeProfile,
  openBrowserRuntimeProviderTabs,
  openTokenlessDashboard,
  getMenuBarSnapshot,
  addControlProfile,
  clearControlProfiles,
  quiesceBrowserRuntime,
  readDaemonToken,
  resolveProviderConversation,
  resolveProviderMapping,
  resolveControlProfile,
  resolveControlExecution,
  removeControlProfile,
  shutdownDaemon,
  waitDaemonJobResult,
  startAgentRun,
  readAgentRun,
  resumeAgentRun,
  cancelAgentRun,
  setDefaultControlProfile,
  updateControlConfig,
  updateControlProfileConfig,
  updateControlProfileObservation,
  updateOutputSavings,
} from './http/daemon-client.js'

export type {
  CancelDaemonJobOptions,
  CreateDaemonJobOptions,
  DaemonClientOptions,
  DaemonJob,
  GetDaemonJobOptions,
  GenerateImageOptions,
  GetProviderCapacityOptions,
  ListDaemonJobsOptions,
  BrowserRuntimeStatus,
  BrowserRuntimeOpenProfileOptions,
  BrowserRuntimeOpenProfileResponse,
  BrowserRuntimeOpenProviderTabsOptions,
  BrowserRuntimeOpenProviderTabsResponse,
  OpenDashboardOptions,
  OpenDashboardResponse,
  MenuBarConversation,
  MenuBarSnapshot,
  ResolveProviderMappingOptions,
  ResolveProviderConversationOptions,
  ShutdownDaemonOptions,
  ShutdownDaemonResponse,
  WaitDaemonJobResultOptions,
  AgentRunClientOptions,
  ControlProfile,
  ControlState,
  ResolveControlProfileResponse,
} from './http/daemon-client.js'

export type { ManagedProfileConfig, TokenlessConfig } from '#tokenless-server/persistence/config.js'
export type { OutputSavingsConfig } from '#tokenless-server/persistence/config.js'
export { API_PROXY_CONVERSATION_MODES } from '#tokenless-server/persistence/config.js'
export type { ApiProxyConfig, ApiProxyConversationMode } from '#tokenless-server/persistence/config.js'
export type { DirectProviderConfig, G4fConfig, ProviderBackend } from '#tokenless-server/persistence/config.js'
export * from '#tokenless-server/providers/direct/g4f/index.js'
export * from '#tokenless-server/providers/direct/g4f-map.js'
export * from '#tokenless-server/providers/direct/protocol-router.js'
export type { BrowserVisibility, EffectiveBrowserVisibility } from '#tokenless-server/browser-visibility.js'

export {
  BROWSER_VISIBILITIES,
  normalizeBrowserVisibility,
  resolveEffectiveBrowserVisibility,
} from '#tokenless-server/browser-visibility.js'

export {
  configPath,
  deleteTokenlessProfileConfig,
  deriveTaskId,
  normalizeBrowserId,
  normalizeManagedProfileProxy,
  readTokenlessConfig,
  TOKENLESS_CONFIG_SCHEMA_ID,
  upsertTokenlessProfileConfig,
  writeTokenlessConfig,
  hasConfiguredTokenlessLanguage,
} from '#tokenless-server/persistence/config.js'

export {
  TOKENLESS_LANGUAGES,
  detectSystemLanguage,
  normalizeTokenlessLanguage,
} from './localization.js'

export type { TokenlessLanguage } from './localization.js'

export {
  BROWSER_SELECTIONS,
  SYSTEM_BROWSER_IDS,
  BrowserRuntimeManager,
  allManagedBrowserCatalogEntries,
  currentBrowserRuntimePlatform,
  managedBrowserCatalogEntry,
  normalizeBrowserSelection,
} from '#tokenless-server/browser/runtime/index.js'

export type {
  BrowserCandidate,
  BrowserLaunchPolicy,
  BrowserRuntimeBinding,
  BrowserRuntimeFamily,
  BrowserRuntimeInspection,
  BrowserRuntimePlatform,
  BrowserSelection,
  ResolvedBrowserRuntime,
} from '#tokenless-server/browser/runtime/index.js'

export {
  OUTPUT_SAVINGS_ESTIMATOR,
  OUTPUT_SAVINGS_RUNTIME_CATALOG,
  OUTPUT_SAVINGS_RUNTIME_DOWNLOAD_BYTES,
  OUTPUT_SAVINGS_RUNTIME_ID,
  OUTPUT_SAVINGS_RUNTIME_INSTALLED_BYTES,
  OUTPUT_SAVINGS_RUNTIME_VERSION,
  OutputSavingsRuntimeManager,
} from '#tokenless-server/output-savings/index.js'

export type { OutputSavingsRuntimeInspection } from '#tokenless-server/output-savings/index.js'
export type {
  MeasureVisibleOutput,
  OutputSavingsMeasurement,
  OutputSavingsResult,
  OutputSavingsUnavailable,
} from '#tokenless-server/output-savings/index.js'

export {
  DAEMON_CONTROL_API_REVISION,
  DAEMON_LOG_FILE,
  DAEMON_PID_FILE,
  DAEMON_PROCESS_SCHEMA_ID,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V3,
  MANAGED_PLAYWRIGHT_JOB_SCHEMA_ID_V4,
  VISIBLE_ACTION_SCHEMA_ID,
  VISIBLE_ACTION_SCHEMA_ID_V3,
  ensureDaemonReady,
  ensureSetupDaemonRunnable,
  inspectManagedRuntime,
  openProviderUrl,
  persistDaemonSnapshot,
  probeDaemonReady,
  providerWakeUrl,
  resolveChromiumBrowser,
  semanticVersionMajor,
  stopDaemon,
} from './bootstrap/runtime.js'

export {
  DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
  DEFAULT_VISIBLE_ATTACHMENT_ORPHAN_TTL_MS,
  VISIBLE_ATTACHMENT_DIRECTORY,
  VISIBLE_ATTACHMENT_SCHEMA_ID,
  cleanupOrphanedVisibleAttachmentBundles,
  createVisibleAttachmentId,
  removeStagedVisibleAttachmentBundle,
  stageVisibleAttachment,
  stageVisibleAttachments,
  validateVisibleAttachmentDescriptor,
  visibleAttachmentBundlePath,
  visibleAttachmentPath,
  visibleAttachmentRoot,
} from '#tokenless-server/persistence/attachments.js'

export type {
  StageVisibleAttachmentOptions,
  StageVisibleAttachmentsOptions,
  VisibleAttachmentDescriptor,
} from '#tokenless-server/persistence/attachments.js'

export type {
  ChromiumBrowser,
  DaemonReadyProbe,
  EnsureDaemonOptions,
  ManagedRuntimeInspection,
  StopDaemonResult,
} from './bootstrap/runtime.js'

const DEFAULT_MAX_FILE_BYTES = 24_000
const DEFAULT_MAX_TOTAL_BYTES = 80_000

type TokenlessPromptOptions = {
  userPrompt?: string
  projectRoot?: string
  files?: string[]
  turnContext?: unknown
  maxFileBytes?: number
  maxTotalBytes?: number
  responseLanguage?: TokenlessLanguage
}

type CollectedFile = {
  path: string
  truncated: boolean
  text: string
}

export async function buildTokenlessPrompt({
  userPrompt,
  projectRoot = process.cwd(),
  files = [],
  turnContext,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  responseLanguage = 'en',
}: TokenlessPromptOptions = {}) {
  if (typeof userPrompt !== 'string' || userPrompt.trim() === '') {
    throw new TypeError('userPrompt must be a nonempty string.')
  }

  const root = await fs.realpath(path.resolve(projectRoot))
  const selectedFiles = await collectFiles(root, files, maxFileBytes, maxTotalBytes)

  return [
    '# Tokenless Request',
    '',
    '## User Prompt',
    userPrompt.trim(),
    '',
    '## Response Language',
    responseLanguage === 'zh-CN'
      ? 'Respond in Simplified Chinese unless the user prompt explicitly requests another language.'
      : 'Respond in English unless the user prompt explicitly requests another language.',
    '',
    '## Shareable Turn Context',
    sanitizeText(turnContext ?? 'No additional shareable turn context was provided.'),
    '',
    '## Project Root',
    root,
    '',
    '## Relevant Files',
    selectedFiles.length === 0
      ? 'No relevant files were attached.'
      : selectedFiles.map(formatFile).join('\n\n'),
  ].join('\n')
}

export async function collectFiles(projectRoot: string, files: string[], maxFileBytes: number, maxTotalBytes: number) {
  const root = await fs.realpath(path.resolve(projectRoot))
  const result: CollectedFile[] = []
  let total = 0
  for (const file of files) {
    const requested = path.resolve(projectRoot, file)
    if (!isPathWithin(path.resolve(projectRoot), requested)) {
      throw new Error(`File is outside project root: ${file}`)
    }
    const absolute = await fs.realpath(requested)
    if (!isPathWithin(root, absolute)) {
      throw new Error(`File resolves outside project root: ${file}`)
    }
    const initialStat = await fs.stat(absolute)
    if (!initialStat.isFile()) continue
    const handle = await fs.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) continue
      await verifyOpenedFileIdentity({ requested, root, handle, file })
      const bytesToRead = Math.min(stat.size, maxFileBytes, Math.max(0, maxTotalBytes - total))
      if (bytesToRead <= 0) break
      const buffer = Buffer.alloc(bytesToRead)
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
      total += bytesRead
      result.push({
        path: path.relative(root, absolute),
        truncated: stat.size > bytesRead,
        text: sanitizeText(buffer.subarray(0, bytesRead).toString('utf8')),
      })
    } finally {
      await handle.close()
    }
  }
  return result
}

async function verifyOpenedFileIdentity({
  requested,
  root,
  handle,
  file,
}: {
  requested: string
  root: string
  handle: fs.FileHandle
  file: string
}) {
  const openedStat = await handle.stat({ bigint: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const firstRealPath = await fs.realpath(requested)
    if (!isPathWithin(root, firstRealPath)) {
      throw new Error(`File resolves outside project root after opening: ${file}`)
    }
    const firstStat = await fs.stat(firstRealPath, { bigint: true })
    const secondRealPath = await fs.realpath(requested)
    const secondStat = await fs.stat(secondRealPath, { bigint: true })
    if (
      firstRealPath === secondRealPath &&
      isPathWithin(root, secondRealPath) &&
      sameFileIdentity(openedStat, firstStat) &&
      sameFileIdentity(openedStat, secondStat)
    ) {
      return
    }
  }
  throw new Error(`File changed while enforcing project-root containment: ${file}`)
}

function sameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
) {
  return left.dev === right.dev && left.ino === right.ino
}

function isPathWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function formatFile(file: CollectedFile) {
  return [
    `### ${file.path}${file.truncated ? ' (truncated)' : ''}`,
    '```',
    file.text,
    '```',
  ].join('\n')
}

function sanitizeText(text: unknown) {
  return String(text)
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\n]+/gi, '$1=<redacted>')
    .trim()
}
