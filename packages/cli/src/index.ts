import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

export {
  DEFAULT_DAEMON_URL,
  MAX_NATIVE_MESSAGE_BYTES,
  cancelDaemonJob,
  claimNextDaemonJob,
  completeDaemonJob,
  createDaemonJob,
  daemonUrl,
  getDaemonJob,
  listDaemonJobs,
  readDaemonToken,
  resumeDaemonJob,
  waitDaemonJobResult,
} from './daemon-client.js'

export type {
  ClaimNextDaemonJobOptions,
  CancelDaemonJobOptions,
  CompleteDaemonJobOptions,
  CreateDaemonJobOptions,
  DaemonClaimedJob,
  DaemonClientOptions,
  DaemonJob,
  GetDaemonJobOptions,
  ListDaemonJobsOptions,
  ResumeDaemonJobOptions,
  WaitDaemonJobResultOptions,
} from './daemon-client.js'

export type { TokenlessConfig } from './job-store.js'
export type { BrowserVisibility, EffectiveBrowserVisibility } from './browser-visibility.js'

export {
  BROWSER_VISIBILITIES,
  normalizeBrowserVisibility,
  resolveEffectiveBrowserVisibility,
} from './browser-visibility.js'

export {
  configPath,
  deriveTaskId,
  NATIVE_HOST_NAME,
  normalizeBrowserId,
  nativeMessagingHostDir,
  nativeMessagingHostDirs,
  readTokenlessConfig,
  TOKENLESS_CONFIG_PROTOCOL_VERSION,
  tokenlessHome,
  writeTokenlessConfig,
} from './job-store.js'

export {
  DAEMON_LOG_FILE,
  DAEMON_PID_FILE,
  DAEMON_PROCESS_PROTOCOL,
  DAEMON_PROCESS_PROOF_PROTOCOL,
  DAEMON_PROTOCOL,
  DAEMON_READY_PROOF_PROTOCOL,
  EXTENSION_BRIDGE_FILE,
  EXTENSION_BRIDGE_PROTOCOL,
  NATIVE_BINARY_BUILD_INFO_PROTOCOL,
  NATIVE_PROTOCOL,
  bundledRustBinaryPath,
  ensureDaemonReady,
  inspectNativeHostManifests,
  inspectRustBinaries,
  inspectManagedRuntime,
  installNativeHost,
  installRustRuntime,
  installedRustBinaryPath,
  openProviderUrl,
  persistDaemonSnapshot,
  probeDaemonReady,
  providerWakeUrl,
  readLiveBridgeMarker,
  refreshInstalledRustBinaries,
  refreshInstalledManagedRuntime,
  resolveChromiumBrowser,
  resolveDaemonBinary,
  waitForExtensionBridge,
  windowsNativeHostRegistryCommands,
} from './runtime.js'

export {
  NATIVE_PLATFORM_PACKAGE_PROTOCOL,
  NATIVE_PLATFORM_PACKAGES,
  nativePlatformPackageName,
  resolveNativePlatformPackage,
} from './platform-package.js'

export type { ResolveNativePlatformPackageOptions } from './platform-package.js'

export {
  DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
  DEFAULT_VISIBLE_ATTACHMENT_ORPHAN_TTL_MS,
  VISIBLE_ATTACHMENT_DIRECTORY,
  VISIBLE_ATTACHMENT_PROTOCOL,
  cleanupOrphanedVisibleAttachmentBundles,
  createVisibleAttachmentId,
  removeStagedVisibleAttachmentBundle,
  stageVisibleAttachment,
  stageVisibleAttachments,
  validateVisibleAttachmentDescriptor,
  visibleAttachmentBundlePath,
  visibleAttachmentPath,
  visibleAttachmentRoot,
} from './visible-attachments.js'

export type {
  StageVisibleAttachmentOptions,
  StageVisibleAttachmentsOptions,
  VisibleAttachmentDescriptor,
} from './visible-attachments.js'

export type {
  BridgeMarker,
  ChromiumBrowser,
  DaemonReadyProbe,
  EnsureDaemonOptions,
  InstallRustRuntimeOptions,
  ManagedRuntimeInspection,
} from './runtime.js'

const DEFAULT_MAX_FILE_BYTES = 24_000
const DEFAULT_MAX_TOTAL_BYTES = 80_000

type TokenlessPromptOptions = {
  userPrompt?: string
  projectRoot?: string
  files?: string[]
  turnContext?: unknown
  maxFileBytes?: number
  maxTotalBytes?: number
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
