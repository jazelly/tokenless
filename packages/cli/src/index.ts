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
  WaitDaemonJobResultOptions,
} from './daemon-client.js'

export type { TokenlessConfig } from './job-store.js'

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
  DAEMON_PROTOCOL,
  DAEMON_READY_PROOF_PROTOCOL,
  EXTENSION_BRIDGE_FILE,
  EXTENSION_BRIDGE_PROTOCOL,
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
} from './runtime.js'

export { executeDirectRun, resolveDirectBackend } from './direct/client.js'

export type { ExecuteDirectRunOptions } from './direct/client.js'

export {
  executeChatGptApi,
  executeDirectApi,
  MAX_DIRECT_REQUEST_BYTES,
} from './direct/api-client.js'

export type { ExecuteChatGptApiOptions, ExecuteDirectApiOptions } from './direct/api-client.js'

export {
  DEFAULT_DIRECT_BROKER_HOST,
  DEFAULT_DIRECT_BROKER_PORT,
  DEFAULT_DIRECT_BROKER_REQUEST_BYTES,
  DIRECT_BROKER_CAPABILITIES_PATH,
  DIRECT_BROKER_HEALTH_PATH,
  DIRECT_BROKER_PROTOCOL,
  MAX_DIRECT_BROKER_REQUEST_BYTES,
  startDirectBroker,
} from './direct/broker.js'

export type {
  DirectBrokerHandle,
  ProjectApiBrokerOptions,
  StartDirectBrokerOptions,
} from './direct/broker.js'

export {
  DEFAULT_MANAGED_PROJECT_QUEUE_DEPTH,
  DEFAULT_MANAGED_PROJECT_QUEUE_WAIT_MS,
  MAX_MANAGED_PROJECT_QUEUE_DEPTH,
  MAX_MANAGED_PROJECT_QUEUE_WAIT_MS,
  ManagedProjectExecutorError,
  ProjectCodexRouter,
  ProjectCodexRouterError,
  validateManagedProjectId,
} from './direct/project-codex-router.js'

export type {
  ManagedProjectExecution,
  ManagedProjectExecutor,
  ManagedProjectExecutorErrorCode,
  ManagedProjectRequestLoader,
  ProjectCodexRouterErrorCode,
  ProjectCodexRouterOptions,
} from './direct/project-codex-router.js'

export {
  MANAGED_RESPONSES_DEFAULT_MODEL,
  MANAGED_RESPONSES_DELTA_BYTES,
  MAX_MANAGED_RESPONSES_BODY_BYTES,
  MAX_MANAGED_RESPONSES_INPUT_BYTES,
  MAX_MANAGED_RESPONSES_MODEL_BYTES,
  MAX_MANAGED_RESPONSES_OUTPUT_BYTES,
  createManagedResponsesEvents,
  createManagedResponsesResponse,
  createManagedResponsesSse,
  encodeManagedResponsesSse,
  parseManagedResponsesRequest,
} from './direct/managed-responses.js'

export type {
  ManagedResponse,
  ManagedResponseEvent,
  ManagedResponsesMetadata,
  ManagedResponsesRequest,
} from './direct/managed-responses.js'

export {
  chatGptResponsesUrl,
  DEFAULT_DIRECT_CHATGPT_BASE_URL,
  DEFAULT_DIRECT_TIMEOUT_MS,
  MAX_DIRECT_TIMEOUT_MS,
  resolveDirectApiConfig,
  validateDirectBaseUrl,
} from './direct/config.js'

export type {
  ResolvedDirectApiConfig,
  ResolveDirectApiConfigOptions,
} from './direct/config.js'

export { DirectOfficialClientError, runOfficialCodex } from './direct/official-client.js'

export type {
  DirectOfficialClientErrorReason,
  OfficialCodexOptions,
} from './direct/official-client.js'

export {
  ACCOUNT_POOL_PROTOCOL,
  AccountPoolError,
  AccountPoolStore,
  accountPoolAccountLockPath,
  accountPoolDirectDirectory,
  accountPoolProfilePath,
  accountPoolStatePath,
  apiCredentialEnvironmentName,
  normalizeAccountId,
  normalizeRoutingDomain,
  withProcessLocalAccountPoolSerialization,
} from './direct/account-pool.js'

export type {
  AccountPoolProtocol,
  AccountPoolSerialization,
  AccountPoolSnapshot,
  AccountRecord,
  AccountResolution,
  AccountStatus,
  ApiAccountRecord,
  BindingAssignment,
  CodexAccountRecord,
  MigrationResult,
  ProjectBinding,
  ProjectFailoverPolicy,
} from './direct/account-pool.js'

export {
  AccountPoolLockError,
  accountPoolLockPath,
  createSqliteAccountPoolSerialization,
} from './direct/account-pool-lock.js'

export type { SqliteAccountPoolSerializationOptions } from './direct/account-pool-lock.js'

export {
  CODEX_ACCOUNT_CREDENTIAL_STORE,
  CODEX_IDENTITY_FINGERPRINT_VERSION,
  CODEX_IDENTITY_KEY_BYTES,
  CodexProfileError,
  assertManagedCodexHome,
  codexIdentityKeyPath,
  createManagedCodexHome,
  directAccountStateDir,
  fingerprintCodexIdentity,
  inspectCodexAccount,
  managedCodexHome,
  readCodexIdentityKey,
  readOrCreateCodexIdentityKey,
  resolveTrustedCodexCommand,
  resolveTrustedCodexExecutable,
} from './direct/codex-profile.js'

export type {
  CodexAccountObservation,
  InspectCodexAccountOptions,
  TrustedCodexCommand,
} from './direct/codex-profile.js'

export {
  CodexAccountAdminError,
  addManagedCodexAccount,
  chatGptInferenceLockPath,
  chatGptLoginLockPath,
  createManagedAccountPoolStore,
  inspectManagedCodexAccount,
  loginManagedCodexAccount,
  publicAccountRecord,
} from './direct/codex-account-admin.js'

export type {
  CodexAccountAdminOptions,
  CodexAccountHealth,
  CodexAccountStatus,
} from './direct/codex-account-admin.js'

export {
  DEFAULT_SQLITE_LOCK_TIMEOUT_MS,
  MAX_SQLITE_LOCK_TIMEOUT_MS,
  SqliteLockError,
  resolveSqliteLockTimeout,
  withSqliteLocks,
} from './direct/sqlite-lock.js'

export type {
  SqliteLockErrorCode,
  WithSqliteLocksOptions,
} from './direct/sqlite-lock.js'

export { DIRECT_PROTOCOL, DirectError } from './direct/types.js'

export type {
  DirectBackend,
  DirectCapability,
  DirectErrorCode,
  DirectErrorJson,
  DirectErrorOptions,
  DirectProtocol,
  DirectProvider,
  DirectRunRequest,
  DirectRunResult,
  DirectTransport,
  DirectUsage,
} from './direct/types.js'

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
