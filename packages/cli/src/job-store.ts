import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_JOB_PROTOCOL_VERSION = 'tokenless.local-job.v1'
export const CONVERSATION_MAP_PROTOCOL_VERSION = 'tokenless.conversation-map.v1'
export const TOKENLESS_CONFIG_PROTOCOL_VERSION = 'tokenless.config.v1'
export const NATIVE_HOST_NAME = 'dev.tokenless.native_host'

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  RUNNING: 'running',
  NEEDS_USER: 'needs_user',
  BLOCKED: 'blocked',
  UI_MISMATCH: 'ui_mismatch',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  TIMED_OUT: 'timed_out',
})

const FINAL_STATES = new Set([
  JOB_STATES.BLOCKED,
  JOB_STATES.UI_MISMATCH,
  JOB_STATES.SUCCEEDED,
  JOB_STATES.FAILED,
  JOB_STATES.CANCELED,
  JOB_STATES.TIMED_OUT,
])

const BLOCKED_ERROR_CODES = new Set([
  'provider_blocker_visible',
  'provider_landing_blocked',
])

const UI_MISMATCH_ERROR_CODES = new Set([
  'provider_landing_unavailable',
  'selector_drift',
])

const TIMED_OUT_ERROR_CODES = new Set([
  'provider_landing_timeout',
  'response_unavailable',
])

const conversationMapLocks = new Map()
const SUPPORTED_PROVIDER_IDS = Object.freeze(['chatgpt', 'claude', 'gemini'])
export const SUPPORTED_BROWSER_IDS = Object.freeze([
  'chrome',
  'chrome-for-testing',
  'chrome-for-testing-legacy',
  'chromium',
  'edge',
  'arc',
  'brave',
  'profile',
])

type JsonRecord = Record<string, any>
type LocalError = Error & {
  code?: string
  retryable?: boolean
}
type LockFunction<T> = () => Promise<T>

export function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

export function normalizeBrowserId(browser: unknown) {
  if (typeof browser !== 'string') return null
  const normalized = browser.trim().toLowerCase().replace(/[_\s]+/g, '-')
  if (!normalized) return null
  const aliases: Record<string, string> = {
    'google-chrome': 'chrome',
    googlechrome: 'chrome',
    'chrome-testing': 'chrome-for-testing',
    'chrome-for-testing': 'chrome-for-testing',
    'chrome-for-testing-legacy': 'chrome-for-testing-legacy',
    'chromium-browser': 'chromium',
    'microsoft-edge': 'edge',
    msedge: 'edge',
    'brave-browser': 'brave',
  }
  const browserId = aliases[normalized] ?? normalized
  return SUPPORTED_BROWSER_IDS.includes(browserId) ? browserId : null
}

export function jobsDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'jobs')
}

export function metaDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'meta')
}

export function snapshotsDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'snapshots')
}

export function conversationMapPath(homeDir = tokenlessHome()) {
  return path.join(metaDir(homeDir), 'conversations.json')
}

export function configPath(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'config.json')
}

export function createJobId() {
  return globalThis.crypto?.randomUUID?.() ?? `job-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createNonce() {
  const bytes = new Uint8Array(24)
  globalThis.crypto?.getRandomValues?.(bytes)
  if (bytes.some((byte) => byte !== 0)) {
    return Buffer.from(bytes).toString('base64url')
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function deriveTaskId({ projectName, chatName, idempotencyKey }: JsonRecord = {}) {
  return normalizeIdempotencyKey(idempotencyKey) ??
    derivedConversationKey({
      projectName: normalizeDisplayName(projectName),
      chatName: normalizeDisplayName(chatName),
    })
}

export async function ensureJobStore(homeDir = tokenlessHome()) {
  await fs.mkdir(jobsDir(homeDir), { recursive: true, mode: 0o700 })
  await fs.mkdir(metaDir(homeDir), { recursive: true, mode: 0o700 })
  await fs.mkdir(snapshotsDir(homeDir), { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  await fs.chmod(jobsDir(homeDir), 0o700).catch(() => undefined)
  await fs.chmod(metaDir(homeDir), 0o700).catch(() => undefined)
  await fs.chmod(snapshotsDir(homeDir), 0o700).catch(() => undefined)
}

export async function createLocalJob({
  homeDir = tokenlessHome(),
  provider = 'chatgpt',
  action = 'submit_and_read',
  prompt,
  projectRoot,
  projectName,
  chatName,
  targetUrl,
  idempotencyKey,
  readDelayMs = 1000,
  readTimeoutMs = 120000,
  metadata,
  includeText,
  maxTextChars,
  ttlMs = 15 * 60 * 1000,
}: JsonRecord = {}) {
  const promptIsRequired = action === 'submit' || action === 'submit_and_read'
  if (promptIsRequired && (typeof prompt !== 'string' || prompt.trim() === '')) {
    throw new TypeError('prompt must be a nonempty string.')
  }
  await ensureJobStore(homeDir)
  const normalizedProjectName = normalizeDisplayName(projectName ?? metadata?.projectName)
  const normalizedChatName = normalizeDisplayName(chatName ?? metadata?.chatName)
  const taskId = deriveTaskId({
    projectName: normalizedProjectName,
    chatName: normalizedChatName,
    idempotencyKey: idempotencyKey ?? metadata?.idempotencyKey ?? metadata?.conversationKey,
  })
  const conversation = await resolveConversationTarget({
    homeDir,
    provider,
    targetUrl,
    idempotencyKey: taskId,
  })
  const now = new Date()
  const jobId = createJobId()
  const nonce = createNonce()
  const request = {
    protocol: LOCAL_JOB_PROTOCOL_VERSION,
    jobId,
    nonce,
    status: JOB_STATES.QUEUED,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    provider,
    action,
    prompt,
    projectRoot: projectRoot ? path.resolve(projectRoot) : undefined,
    projectName: normalizedProjectName,
    chatName: normalizedChatName,
    taskId: conversation.idempotencyKey,
    targetUrl: conversation.targetUrl,
    idempotencyKey: conversation.idempotencyKey,
    conversation,
    readDelayMs,
    readTimeoutMs,
    includeText,
    maxTextChars,
    metadata: {
      ...(metadata ?? {}),
      projectName: normalizedProjectName,
      chatName: normalizedChatName,
      taskId: conversation.idempotencyKey,
      idempotencyKey: conversation.idempotencyKey,
      conversationRoute: conversation.route,
    },
  }
  await writeJsonAtomic(jobPath(homeDir, jobId, 'request'), request, 0o600)
  await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.QUEUED, actor: 'tokenless-cli' })
  return request
}

export async function readLocalTaskState({
  homeDir = tokenlessHome(),
  taskId,
  jobId,
  provider,
  projectName,
  chatName,
  limit = 10,
}: JsonRecord = {}) {
  const normalizedTaskId = deriveTaskId({ projectName, chatName, idempotencyKey: taskId })
  if (!normalizedTaskId && !jobId) {
    throw accessError('missing_task_id', 'Usage: tokenless state requires --task-id or --job-id.')
  }
  await ensureJobStore(homeDir)
  const jobs = (await readJobDetails(homeDir))
    .filter((job) => {
      if (jobId && job.jobId !== jobId) return false
      if (normalizedTaskId && job.taskId !== normalizedTaskId) return false
      if (provider && job.provider !== provider) return false
      return true
    })
    .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? 0) - Date.parse(a.updatedAt ?? a.createdAt ?? 0))

  if (jobs.length === 0) {
    throw accessError('task_state_not_found', `No Tokenless task state found for ${normalizedTaskId ?? jobId}.`)
  }

  const latest = jobs[0]!
  const resolvedTaskId = normalizedTaskId ?? latest.taskId
  const conversations = await readConversationMap(homeDir)
  const conversation = resolvedTaskId
    ? conversations.conversations[conversationMapKey(provider ?? latest.provider, resolvedTaskId)] ?? null
    : null

  return {
    protocol: LOCAL_JOB_PROTOCOL_VERSION,
    taskId: resolvedTaskId,
    provider: provider ?? latest.provider,
    latest,
    jobs: jobs.slice(0, Math.max(1, Number(limit) || 10)),
    conversation,
  }
}

export async function readLocalJobRequest({ homeDir = tokenlessHome(), jobId, nonce }: JsonRecord = {}) {
  const request = await readJson(jobPath(homeDir, jobId, 'request'))
  validateJobAccess(request, jobId, nonce)
  if (Date.now() > Date.parse(request.expiresAt)) {
    await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.TIMED_OUT, actor: 'job-store' })
    throw accessError('job_expired', 'Local job has expired.')
  }
  return request
}

export async function writeDomSnapshot({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  provider,
  snapshot,
}: JsonRecord = {}) {
  const request = await readLocalJobRequest({ homeDir, jobId, nonce })
  if (request.action !== 'snapshot_dom') {
    throw accessError('invalid_snapshot_job', 'Local job is not a DOM snapshot job.')
  }
  if (!snapshot || snapshot.status !== 'snapshotted') {
    throw accessError('invalid_snapshot_payload', 'DOM snapshot payload is invalid.')
  }

  const snapshotProvider = normalizeSafeSegment(provider || snapshot.provider || request.provider || 'provider')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = path.join(snapshotsDir(homeDir), snapshotProvider, `${stamp}-${jobId}`)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })

  const htmlPath = path.join(dir, 'dom.sanitized.html')
  const probesPath = path.join(dir, 'selector-probes.json')
  const metadataPath = path.join(dir, 'metadata.json')
  const textPath = snapshot.visibleText === undefined ? null : path.join(dir, 'visible-text.txt')

  await fs.writeFile(htmlPath, `${snapshot.html ?? ''}\n`, { mode: 0o600 })
  await fs.writeFile(probesPath, `${JSON.stringify(snapshot.selectorProbes ?? {}, null, 2)}\n`, { mode: 0o600 })
  if (textPath) {
    await fs.writeFile(textPath, `${snapshot.visibleText}\n`, { mode: 0o600 })
  }

  const metadata = {
    protocol: LOCAL_JOB_PROTOCOL_VERSION,
    jobId,
    provider: snapshot.provider ?? request.provider,
    action: request.action,
    capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
    url: snapshot.url,
    title: snapshot.title,
    sanitized: snapshot.sanitized !== false,
    includeText: Boolean(snapshot.includeText),
    htmlPath,
    selectorProbesPath: probesPath,
    visibleTextPath: textPath,
  }
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })

  return {
    ...metadata,
    snapshotDir: dir,
    metadataPath,
  }
}

export async function writeJobState({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  status,
  actor,
  detail,
}: JsonRecord = {}) {
  if (!Object.values(JOB_STATES).includes(status)) {
    throw new Error(`Unsupported job status: ${status}`)
  }
  if (nonce !== undefined) {
    const request = await readJson(jobPath(homeDir, jobId, 'request')).catch(() => null)
    if (request) validateJobAccess(request, jobId, nonce)
  }
  const state = {
    protocol: LOCAL_JOB_PROTOCOL_VERSION,
    jobId,
    nonce,
    status,
    actor,
    detail,
    updatedAt: new Date().toISOString(),
  }
  await ensureJobStore(homeDir)
  await writeJsonAtomic(jobPath(homeDir, jobId, 'state'), state, 0o600)
  return state
}

export async function completeLocalJob({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  ok,
  result,
  error,
  actor = 'native-host',
}: JsonRecord = {}) {
  const request = await readLocalJobRequest({ homeDir, jobId, nonce })
  let mappingError: LocalError | null = null
  if (ok) {
    try {
      await rememberConversationFromResult({ homeDir, request, result })
    } catch (error) {
      mappingError = localStateError(
        'conversation_map_error',
        `Failed to persist Tokenless conversation mapping: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const normalizedError = normalizeError(mappingError ?? error)
  const succeeded = Boolean(ok) && !mappingError
  const status = succeeded ? JOB_STATES.SUCCEEDED : failedJobStatus(normalizedError)
  const payload = {
    protocol: LOCAL_JOB_PROTOCOL_VERSION,
    jobId,
    nonce,
    requestId: request.jobId,
    ok: succeeded,
    provider: request.provider,
    action: request.action,
    status,
    completedAt: new Date().toISOString(),
    compactOutput: succeeded ? compactResult(result) : undefined,
    result: succeeded ? result ?? null : null,
    error: succeeded ? null : normalizedError,
  }
  await writeJsonAtomic(jobPath(homeDir, jobId, 'result'), payload, 0o600)
  await writeJobState({ homeDir, jobId, nonce, status, actor })
  return payload
}

export async function readConversationMap(homeDir = tokenlessHome()): Promise<JsonRecord> {
  const mapPath = conversationMapPath(homeDir)
  let payload
  try {
    payload = await readJson(mapPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return emptyConversationMap()
    }
    throw localStateError(
      'conversation_map_unreadable',
      `Cannot read Tokenless conversation map at ${mapPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validateConversationMap(payload, mapPath)
  return payload
}

export async function readTokenlessConfig(homeDir = tokenlessHome()): Promise<JsonRecord> {
  const file = configPath(homeDir)
  let payload
  try {
    payload = await readJson(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return emptyTokenlessConfig()
    }
    throw localStateError(
      'tokenless_config_unreadable',
      `Cannot read Tokenless config at ${file}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validateTokenlessConfig(payload, file)
  return {
    ...payload,
    preferredProviders: normalizeProviderList(payload.preferredProviders),
    browser: normalizeBrowserId(payload.browser),
    daemonUrl: normalizeDaemonUrl(payload.daemonUrl),
  }
}

export async function writeTokenlessConfig({
  homeDir = tokenlessHome(),
  preferredProviders,
  browser,
  daemonUrl,
}: JsonRecord = {}) {
  await ensureJobStore(homeDir)
  const current = await readTokenlessConfig(homeDir)
  const now = new Date().toISOString()
  const config = {
    protocol: TOKENLESS_CONFIG_PROTOCOL_VERSION,
    updatedAt: now,
    preferredProviders: preferredProviders === undefined
      ? normalizeProviderList(current.preferredProviders)
      : normalizeProviderList(preferredProviders),
    browser: browser === undefined ? normalizeBrowserId(current.browser) : normalizeBrowserId(browser),
    daemonUrl: daemonUrl === undefined ? normalizeDaemonUrl(current.daemonUrl) : normalizeDaemonUrl(daemonUrl),
  }
  await writeJsonAtomic(configPath(homeDir), config, 0o600)
  return config
}

export async function upsertConversationMapping({
  homeDir = tokenlessHome(),
  provider,
  idempotencyKey,
  targetUrl,
  jobId,
  projectName,
  chatName,
  projectRoot,
}: JsonRecord = {}) {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey || typeof provider !== 'string' || typeof targetUrl !== 'string') {
    return null
  }
  const parsedUrl = safeUrl(targetUrl)
  if (!parsedUrl || providerForUrl(parsedUrl.href) !== provider || !isConversationUrl(provider, parsedUrl)) {
    return null
  }

  return withConversationMapLock(homeDir, async () => {
    const map = await readConversationMap(homeDir)
    const now = new Date().toISOString()
    const key = conversationMapKey(provider, normalizedKey)
    const existing = map.conversations[key]
    const entry = {
      provider,
      idempotencyKey: normalizedKey,
      projectName: normalizeDisplayName(projectName) ?? existing?.projectName,
      chatName: normalizeDisplayName(chatName) ?? existing?.chatName,
      projectRoot: typeof projectRoot === 'string' ? projectRoot : existing?.projectRoot,
      targetUrl: canonicalProviderUrl(parsedUrl),
      providerConversationId: providerConversationId(provider, parsedUrl),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastJobId: jobId,
    }
    map.updatedAt = now
    map.conversations[key] = entry
    await writeJsonAtomic(conversationMapPath(homeDir), map, 0o600)
    return entry
  })
}

export async function readLocalHistory({ homeDir = tokenlessHome(), limit = 50 }: JsonRecord = {}) {
  await ensureJobStore(homeDir)
  const conversations = await readConversationMap(homeDir)
  const rows = new Map<string, JsonRecord>()

  for (const entry of Object.values(conversations.conversations as JsonRecord) as JsonRecord[]) {
    const key = historyKey(entry.provider, entry.idempotencyKey)
    rows.set(key, normalizeHistoryEntry({
      provider: entry.provider,
      idempotencyKey: entry.idempotencyKey,
      projectName: entry.projectName,
      chatName: entry.chatName,
      projectRoot: entry.projectRoot,
      targetUrl: entry.targetUrl,
      providerConversationId: entry.providerConversationId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastJobId: entry.lastJobId,
      jobCount: 0,
    }))
  }

  for (const job of await readJobSummaries(homeDir)) {
    if (!job.provider || !job.idempotencyKey) continue
    const key = historyKey(job.provider, job.idempotencyKey)
    const existing = rows.get(key)
    const updatedAt = laterIso(existing?.updatedAt, job.updatedAt)
    const jobIsLatest = updatedAt === job.updatedAt
    rows.set(key, normalizeHistoryEntry({
      ...existing,
      provider: job.provider,
      idempotencyKey: job.idempotencyKey,
      projectName: job.projectName ?? existing?.projectName,
      chatName: job.chatName ?? existing?.chatName,
      projectRoot: job.projectRoot ?? existing?.projectRoot,
      targetUrl: existing?.targetUrl ?? job.targetUrl,
      providerConversationId: existing?.providerConversationId,
      createdAt: earlierIso(existing?.createdAt, job.createdAt),
      updatedAt,
      lastJobId: jobIsLatest ? job.jobId : existing?.lastJobId,
      lastStatus: jobIsLatest ? job.status : existing?.lastStatus,
      jobCount: (existing?.jobCount ?? 0) + 1,
    }))
  }

  const history = [...rows.values()]
    .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? 0) - Date.parse(a.updatedAt ?? a.createdAt ?? 0))
    .slice(0, Math.max(1, Number(limit) || 50))

  return {
    protocol: CONVERSATION_MAP_PROTOCOL_VERSION,
    updatedAt: new Date().toISOString(),
    history,
  }
}

export async function waitLocalJobResult({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  timeoutMs = 120000,
  pollMs = 250,
  statusIntervalMs = 10000,
  onStatus,
}: JsonRecord = {}) {
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let lastState: JsonRecord | null = null
  let lastStateKey: string | null = null
  let nextPollStatusAt = startedAt + statusIntervalMs
  while (Date.now() < deadline) {
    const result = await readJson(jobPath(homeDir, jobId, 'result')).catch(() => null)
    if (result) {
      validateJobAccess(result, jobId, nonce)
      await notifyJobStatus(onStatus, {
        type: 'result',
        jobId,
        status: result.status,
        actor: result.actor,
        elapsedMs: Date.now() - startedAt,
      })
      return result
    }
    const state = await readJson(jobPath(homeDir, jobId, 'state')).catch(() => lastState)
    if (state) {
      lastState = state
      const stateKey = `${state.status}:${state.updatedAt ?? ''}`
      if (stateKey !== lastStateKey) {
        lastStateKey = stateKey
        nextPollStatusAt = Date.now() + statusIntervalMs
        await notifyJobStatus(onStatus, {
          type: 'state',
          jobId,
          status: state.status,
          actor: state.actor,
          detail: state.detail,
          updatedAt: state.updatedAt,
          elapsedMs: Date.now() - startedAt,
        })
      } else if (Date.now() >= nextPollStatusAt) {
        nextPollStatusAt = Date.now() + statusIntervalMs
        await notifyJobStatus(onStatus, {
          type: 'poll',
          jobId,
          status: state.status,
          actor: state.actor,
          detail: state.detail,
          updatedAt: state.updatedAt,
          elapsedMs: Date.now() - startedAt,
        })
      }
    }
    if (lastState && FINAL_STATES.has(lastState.status)) {
      throw accessError(lastState.status, `Local job ended without result: ${lastState.status}`)
    }
    await delay(pollMs)
  }
  await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.TIMED_OUT, actor: 'tokenless-cli' })
  await notifyJobStatus(onStatus, {
    type: 'timeout',
    jobId,
    status: JOB_STATES.TIMED_OUT,
    actor: 'tokenless-cli',
    elapsedMs: Date.now() - startedAt,
  })
  throw accessError('job_timeout', 'Timed out waiting for local Tokenless job result.')
}

async function notifyJobStatus(onStatus: unknown, event: JsonRecord) {
  if (typeof onStatus === 'function') {
    await onStatus(event)
  }
}

export async function installNativeHost({
  homeDir = tokenlessHome(),
  manifestHome = os.homedir(),
  extensionId,
  browsers = ['chrome', 'chrome-for-testing', 'chrome-for-testing-legacy', 'chromium', 'edge', 'arc', 'brave'],
  nodePath = process.execPath,
  packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
}: JsonRecord = {}) {
  await fs.mkdir(path.join(homeDir, 'bin'), { recursive: true, mode: 0o700 })
  await fs.chmod(path.join(homeDir, 'bin'), 0o700).catch(() => undefined)
  const hostScript = path.join(packageRoot, 'src', 'native-host.mjs')
  const executable = path.join(homeDir, 'bin', 'tokenless-native-host')
  const wrapper = [
    '#!/bin/sh',
    `exec ${shellQuote(nodePath)} ${shellQuote(hostScript)} "$@"`,
    '',
  ].join('\n')
  await fs.writeFile(executable, wrapper, { mode: 0o755 })
  await fs.chmod(executable, 0o755)

  const manifests: string[] = []
  if (extensionId) {
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: 'Tokenless native messaging host',
      path: executable,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }
    for (const browser of browsers) {
      const browserId = normalizeBrowserId(browser)
      if (!browserId) continue
      for (const dir of nativeMessagingHostDirs(browserId, manifestHome)) {
        await fs.mkdir(dir, { recursive: true, mode: 0o755 })
        const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`)
        await writeJsonAtomic(manifestPath, manifest, 0o644)
        manifests.push(manifestPath)
      }
    }
  }

  return { executable, manifests }
}

export function nativeMessagingHostDir(browser: string, home = os.homedir()) {
  return nativeMessagingHostDirs(browser, home)[0] ?? null
}

export function nativeMessagingHostDirs(browser: string, home = os.homedir()) {
  if (browser === 'profile') {
    return [path.join(home, 'NativeMessagingHosts')]
  }
  const platform = process.platform
  if (platform === 'darwin') {
    const roots = {
      chrome: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
      'chrome-for-testing': ['Library', 'Application Support', 'Google', 'Chrome for Testing', 'NativeMessagingHosts'],
      'chrome-for-testing-legacy': ['Library', 'Application Support', 'Google', 'ChromeForTesting', 'NativeMessagingHosts'],
      chromium: ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'],
      edge: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
      arc: ['Library', 'Application Support', 'Arc', 'User Data', 'NativeMessagingHosts'],
      brave: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
    }
    const root = roots[browser as keyof typeof roots]
    return root ? [path.join(home, ...root)] : []
  }
  if (platform === 'win32') {
    return []
  }
  const roots = {
    chrome: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    'chrome-for-testing': ['.config', 'google-chrome-for-testing', 'NativeMessagingHosts'],
    'chrome-for-testing-legacy': ['.config', 'google-chrome-for-testing', 'NativeMessagingHosts'],
    chromium: ['.config', 'chromium', 'NativeMessagingHosts'],
    edge: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
    arc: null,
    brave: ['.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
  }
  const root = roots[browser as keyof typeof roots]
  return root ? [path.join(home, ...root)] : []
}

export function buildTaskUrl({ extensionId, jobId, nonce }: JsonRecord = {}) {
  if (!extensionId) {
    throw new TypeError('extensionId is required to build a task URL.')
  }
  const params = new URLSearchParams({ jobId, nonce })
  return `chrome-extension://${extensionId}/task/task.html?${params.toString()}`
}

export function jobPath(homeDir: string, jobId: string, kind: string) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(jobId)) {
    throw new Error('Invalid jobId.')
  }
  return path.join(jobsDir(homeDir), `${jobId}.${kind}.json`)
}

async function readJson<T = JsonRecord>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeJsonAtomic(file: string, payload: unknown, mode: number) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.${createJobId()}.tmp`
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(tmp, 'wx', mode)
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle?.close()
  }
  try {
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

function validateJobAccess(payload: JsonRecord | null | undefined, jobId: string, nonce: string) {
  if (payload?.protocol !== LOCAL_JOB_PROTOCOL_VERSION) {
    throw accessError('unsupported_protocol', 'Local job protocol is not supported.')
  }
  if (payload.jobId !== jobId || payload.nonce !== nonce) {
    throw accessError('job_access_denied', 'Local job nonce does not match.')
  }
}

function compactResult(result: JsonRecord | null | undefined) {
  const text = result?.text ?? result?.read?.text ?? result?.result?.read?.text
  if (typeof text !== 'string') {
    if (result?.snapshot?.htmlPath) {
      return result.snapshot.htmlPath
    }
    return ''
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...[truncated]` : text
}

function emptyConversationMap() {
  return {
    protocol: CONVERSATION_MAP_PROTOCOL_VERSION,
    updatedAt: null,
    conversations: {},
  }
}

function emptyTokenlessConfig() {
  return {
    protocol: TOKENLESS_CONFIG_PROTOCOL_VERSION,
    updatedAt: null,
    preferredProviders: [],
    browser: null,
    daemonUrl: null,
  }
}

function validateConversationMap(payload: JsonRecord, mapPath: string) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.protocol !== CONVERSATION_MAP_PROTOCOL_VERSION ||
    !payload.conversations ||
    typeof payload.conversations !== 'object' ||
    Array.isArray(payload.conversations)
  ) {
    throw localStateError('conversation_map_invalid', `Invalid Tokenless conversation map at ${mapPath}.`)
  }
}

function validateTokenlessConfig(payload: JsonRecord, file: string) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    payload.protocol !== TOKENLESS_CONFIG_PROTOCOL_VERSION ||
    (payload.preferredProviders !== undefined && !Array.isArray(payload.preferredProviders)) ||
    (payload.browser !== undefined && payload.browser !== null && !normalizeBrowserId(payload.browser)) ||
    (payload.daemonUrl !== undefined && payload.daemonUrl !== null && !normalizeDaemonUrl(payload.daemonUrl))
  ) {
    throw localStateError('tokenless_config_invalid', `Invalid Tokenless config at ${file}.`)
  }
}

function normalizeDaemonUrl(value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\/+$/, '')
  if (!normalized) return null
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' || !isLoopbackHostname(parsed.hostname)) {
    return null
  }
  return parsed.href.replace(/\/+$/, '')
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function withConversationMapLock<T>(homeDir: string, fn: LockFunction<T>) {
  const lockKey = conversationMapPath(homeDir)
  const prior = conversationMapLocks.get(lockKey) ?? Promise.resolve()
  const run = prior
    .catch(() => undefined)
    .then(() => withConversationMapFileLock(homeDir, fn))
  const chain = run.catch(() => undefined)
  conversationMapLocks.set(lockKey, chain)
  return run.finally(() => {
    if (conversationMapLocks.get(lockKey) === chain) {
      conversationMapLocks.delete(lockKey)
    }
  })
}

async function withConversationMapFileLock<T>(homeDir: string, fn: LockFunction<T>) {
  const lockDir = `${conversationMapPath(homeDir)}.lock`
  await acquireLockDir(lockDir)
  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function acquireLockDir(lockDir: string) {
  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 10000
  while (true) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 })
      await fs.writeFile(
        path.join(lockDir, 'owner'),
        `${process.pid}\n${new Date().toISOString()}\n`,
        { mode: 0o600 }
      ).catch(() => undefined)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error
      }
      const stat = await fs.stat(lockDir).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > 30000) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      if (Date.now() > deadline) {
        throw localStateError('conversation_map_locked', `Timed out waiting for Tokenless conversation map lock at ${lockDir}.`)
      }
      await delay(25)
    }
  }
}

async function resolveConversationTarget({ homeDir, provider, targetUrl, idempotencyKey }: JsonRecord = {}) {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) {
    return {
      idempotencyKey: undefined,
      route: targetUrl ? 'explicit' : 'default',
      targetUrl,
    }
  }

  const map = await readConversationMap(homeDir)
  const existing = map.conversations[conversationMapKey(provider, normalizedKey)]
  if (!targetUrl && existing?.targetUrl) {
    return {
      idempotencyKey: normalizedKey,
      route: 'mapped',
      targetUrl: existing.targetUrl,
      mappedAt: existing.updatedAt,
      providerConversationId: existing.providerConversationId,
    }
  }

  return {
    idempotencyKey: normalizedKey,
    route: targetUrl ? 'explicit' : 'new',
    targetUrl: targetUrl ?? providerHomeUrl(provider),
  }
}

async function rememberConversationFromResult({ homeDir, request, result }: JsonRecord = {}) {
  const idempotencyKey = request?.idempotencyKey ?? request?.metadata?.idempotencyKey
  const targetUrl = result?.read?.url ?? result?.url ?? result?.textUrl ?? result?.submit?.url
  if (!idempotencyKey || !targetUrl) {
    return null
  }
  return upsertConversationMapping({
    homeDir,
    provider: request.provider,
    idempotencyKey,
    targetUrl,
    jobId: request.jobId,
    projectName: request.projectName ?? request.metadata?.projectName,
    chatName: request.chatName ?? request.metadata?.chatName,
    projectRoot: request.projectRoot,
  })
}

async function readJobSummaries(homeDir: string) {
  return (await readJobDetails(homeDir)).map((job) => ({
    jobId: job.jobId,
    provider: job.provider,
    idempotencyKey: job.idempotencyKey,
    projectName: job.projectName,
    chatName: job.chatName,
    projectRoot: job.projectRoot,
    targetUrl: job.targetUrl,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    status: job.status,
  }))
}

async function readJobDetails(homeDir: string) {
  const dir = jobsDir(homeDir)
  const files = await fs.readdir(dir).catch((error) => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const requestFiles = files.filter((file) => file.endsWith('.request.json'))
  const jobs: JsonRecord[] = []
  for (const file of requestFiles) {
    const jobId = file.slice(0, -'.request.json'.length)
    const request = await readJson(path.join(dir, file)).catch(() => null)
    if (!request || request.protocol !== LOCAL_JOB_PROTOCOL_VERSION) continue
    const state = await readJson(jobPath(homeDir, jobId, 'state')).catch(() => null)
    const result = await readJson(jobPath(homeDir, jobId, 'result')).catch(() => null)
    const taskId = request.taskId ?? request.idempotencyKey ?? request.metadata?.taskId ?? request.metadata?.idempotencyKey
    jobs.push({
      jobId,
      taskId,
      provider: request.provider,
      action: request.action,
      idempotencyKey: request.idempotencyKey ?? request.metadata?.idempotencyKey,
      projectName: normalizeDisplayName(request.projectName ?? request.metadata?.projectName),
      chatName: normalizeDisplayName(request.chatName ?? request.metadata?.chatName),
      projectRoot: request.projectRoot,
      targetUrl: request.targetUrl,
      route: request.conversation?.route ?? request.metadata?.conversationRoute,
      createdAt: request.createdAt,
      updatedAt: result?.completedAt ?? state?.updatedAt ?? request.createdAt,
      status: result?.status ?? state?.status ?? request.status,
      state: state ? {
        status: state.status,
        actor: state.actor,
        detail: state.detail,
        updatedAt: state.updatedAt,
      } : null,
      result: result ? {
        ok: result.ok,
        status: result.status,
        completedAt: result.completedAt,
        compactOutput: result.compactOutput,
        error: result.error,
      } : null,
    })
  }
  return jobs
}

function normalizeHistoryEntry(entry: JsonRecord) {
  const projectName = normalizeDisplayName(entry.projectName) ?? projectNameFromRoot(entry.projectRoot) ?? 'Unspecified project'
  const chatName = normalizeDisplayName(entry.chatName) ??
    (normalizeDisplayName(entry.projectName) ? 'Unspecified chat' : entry.idempotencyKey) ??
    'Unspecified chat'
  return {
    provider: entry.provider,
    idempotencyKey: entry.idempotencyKey,
    projectName,
    chatName,
    projectRoot: entry.projectRoot,
    targetUrl: entry.targetUrl,
    providerConversationId: entry.providerConversationId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt ?? entry.createdAt,
    lastJobId: entry.lastJobId,
    lastStatus: entry.lastStatus,
    jobCount: entry.jobCount ?? 0,
  }
}

function normalizeDisplayName(value: unknown) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function derivedConversationKey({ projectName, chatName }: JsonRecord = {}) {
  if (!projectName && !chatName) return undefined
  return [
    projectName ? `project:${projectName}` : null,
    chatName ? `chat:${chatName}` : null,
  ].filter(Boolean).join(':')
}

function projectNameFromRoot(projectRoot: unknown) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') return undefined
  return path.basename(projectRoot)
}

function historyKey(provider: string, idempotencyKey: string) {
  return `${provider}:${idempotencyKey}`
}

function earlierIso(left: string | undefined, right: string | undefined) {
  if (!left) return right
  if (!right) return left
  return Date.parse(left) <= Date.parse(right) ? left : right
}

function laterIso(left: string | undefined, right: string | undefined) {
  if (!left) return right
  if (!right) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

function normalizeIdempotencyKey(idempotencyKey: unknown) {
  if (typeof idempotencyKey !== 'string') return undefined
  const normalized = idempotencyKey.trim()
  return normalized.length > 0 ? normalized : undefined
}

function conversationMapKey(provider: string, idempotencyKey: string) {
  return `${provider}:${idempotencyKey}`
}

function providerHomeUrl(provider: string) {
  const homeUrls = {
    chatgpt: 'https://chatgpt.com/',
    gemini: 'https://gemini.google.com/app',
    claude: 'https://claude.ai/new',
  }
  return homeUrls[provider as keyof typeof homeUrls] ?? undefined
}

function normalizeProviderList(providers: unknown) {
  if (!Array.isArray(providers)) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const provider of providers) {
    if (typeof provider !== 'string') continue
    const value = provider.trim().toLowerCase()
    if (!SUPPORTED_PROVIDER_IDS.includes(value) || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

function normalizeSafeSegment(value: unknown) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'provider'
}

function providerForUrl(url: string | URL) {
  const parsed = typeof url === 'string' ? safeUrl(url) : url
  const host = parsed?.hostname?.toLowerCase()
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt'
  if (host === 'gemini.google.com') return 'gemini'
  if (host === 'claude.ai') return 'claude'
  return null
}

function isConversationUrl(provider: string, url: URL) {
  if (provider === 'chatgpt') return /^\/c\/[^/]+/.test(url.pathname)
  if (provider === 'gemini') return /^\/app\/[^/]+/.test(url.pathname)
  if (provider === 'claude') return /^\/chat\/[^/]+/.test(url.pathname)
  return false
}

function providerConversationId(provider: string, url: URL) {
  if (provider === 'chatgpt') return url.pathname.split('/')[2] || null
  if (provider === 'gemini') return url.pathname.split('/')[2] || null
  if (provider === 'claude') return url.pathname.split('/')[2] || null
  return null
}

function canonicalProviderUrl(url: URL) {
  return `${url.origin}${url.pathname}`
}

function safeUrl(value: string) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeError(error: Partial<LocalError> | null | undefined) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'local_job_error',
    message: typeof error?.message === 'string' ? error.message : 'Local Tokenless job failed.',
    retryable: Boolean(error?.retryable),
  }
}

function failedJobStatus(error: Partial<LocalError> | null | undefined) {
  if (typeof error?.code === 'string' && BLOCKED_ERROR_CODES.has(error.code)) {
    return JOB_STATES.BLOCKED
  }
  if (typeof error?.code === 'string' && UI_MISMATCH_ERROR_CODES.has(error.code)) {
    return JOB_STATES.UI_MISMATCH
  }
  if (typeof error?.code === 'string' && TIMED_OUT_ERROR_CODES.has(error.code)) {
    return JOB_STATES.TIMED_OUT
  }
  return JOB_STATES.FAILED
}

function accessError(code: string, message: string): LocalError {
  const error: LocalError = new Error(message)
  error.code = code
  return error
}

function localStateError(code: string, message: string): LocalError {
  const error: LocalError = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function shellQuote(value: unknown) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
