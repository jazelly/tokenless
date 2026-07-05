import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const LOCAL_JOB_PROTOCOL_VERSION = 'tokenless.local-job.v1'
export const CONVERSATION_MAP_PROTOCOL_VERSION = 'tokenless.conversation-map.v1'
export const NATIVE_HOST_NAME = 'dev.tokenless.native_host'

export const JOB_STATES = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  RUNNING: 'running',
  NEEDS_USER: 'needs_user',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  TIMED_OUT: 'timed_out',
})

const FINAL_STATES = new Set([
  JOB_STATES.SUCCEEDED,
  JOB_STATES.FAILED,
  JOB_STATES.CANCELED,
  JOB_STATES.TIMED_OUT,
])

const conversationMapLocks = new Map()

export function tokenlessHome(explicitHome = process.env.TOKENLESS_HOME) {
  return path.resolve(explicitHome || path.join(os.homedir(), '.tokenless'))
}

export function jobsDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'jobs')
}

export function metaDir(homeDir = tokenlessHome()) {
  return path.join(homeDir, 'meta')
}

export function conversationMapPath(homeDir = tokenlessHome()) {
  return path.join(metaDir(homeDir), 'conversations.json')
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

export async function ensureJobStore(homeDir = tokenlessHome()) {
  await fs.mkdir(jobsDir(homeDir), { recursive: true, mode: 0o700 })
  await fs.mkdir(metaDir(homeDir), { recursive: true, mode: 0o700 })
  await fs.chmod(homeDir, 0o700).catch(() => undefined)
  await fs.chmod(jobsDir(homeDir), 0o700).catch(() => undefined)
  await fs.chmod(metaDir(homeDir), 0o700).catch(() => undefined)
}

export async function createLocalJob({
  homeDir = tokenlessHome(),
  provider = 'chatgpt',
  action = 'submit_and_read',
  prompt,
  projectRoot,
  targetUrl,
  idempotencyKey,
  readDelayMs = 1000,
  readTimeoutMs = 120000,
  metadata,
  ttlMs = 15 * 60 * 1000,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new TypeError('prompt must be a nonempty string.')
  }
  await ensureJobStore(homeDir)
  const conversation = await resolveConversationTarget({
    homeDir,
    provider,
    targetUrl,
    idempotencyKey: idempotencyKey ?? metadata?.idempotencyKey ?? metadata?.conversationKey,
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
    targetUrl: conversation.targetUrl,
    idempotencyKey: conversation.idempotencyKey,
    conversation,
    readDelayMs,
    readTimeoutMs,
    metadata: {
      ...(metadata ?? {}),
      idempotencyKey: conversation.idempotencyKey,
      conversationRoute: conversation.route,
    },
  }
  await writeJsonAtomic(jobPath(homeDir, jobId, 'request'), request, 0o600)
  await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.QUEUED, actor: 'tokenless-cli' })
  return request
}

export async function readLocalJobRequest({ homeDir = tokenlessHome(), jobId, nonce } = {}) {
  const request = await readJson(jobPath(homeDir, jobId, 'request'))
  validateJobAccess(request, jobId, nonce)
  if (Date.now() > Date.parse(request.expiresAt)) {
    await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.TIMED_OUT, actor: 'job-store' })
    throw accessError('job_expired', 'Local job has expired.')
  }
  return request
}

export async function writeJobState({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  status,
  actor,
  detail,
} = {}) {
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
} = {}) {
  const request = await readLocalJobRequest({ homeDir, jobId, nonce })
  let mappingError = null
  if (ok) {
    try {
      await rememberConversationFromResult({ homeDir, request, result })
    } catch (error) {
      mappingError = localStateError(
        'conversation_map_error',
        `Failed to persist Tokenless conversation mapping: ${error.message}`
      )
    }
  }
  const succeeded = Boolean(ok) && !mappingError
  const status = succeeded ? JOB_STATES.SUCCEEDED : JOB_STATES.FAILED
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
    error: succeeded ? null : normalizeError(mappingError ?? error),
  }
  await writeJsonAtomic(jobPath(homeDir, jobId, 'result'), payload, 0o600)
  await writeJobState({ homeDir, jobId, nonce, status, actor })
  return payload
}

export async function readConversationMap(homeDir = tokenlessHome()) {
  const mapPath = conversationMapPath(homeDir)
  let payload
  try {
    payload = await readJson(mapPath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return emptyConversationMap()
    }
    throw localStateError(
      'conversation_map_unreadable',
      `Cannot read Tokenless conversation map at ${mapPath}: ${error.message}`
    )
  }
  validateConversationMap(payload, mapPath)
  return payload
}

export async function upsertConversationMapping({
  homeDir = tokenlessHome(),
  provider,
  idempotencyKey,
  targetUrl,
  jobId,
} = {}) {
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

export async function waitLocalJobResult({
  homeDir = tokenlessHome(),
  jobId,
  nonce,
  timeoutMs = 120000,
  pollMs = 250,
} = {}) {
  const deadline = Date.now() + timeoutMs
  let lastState = null
  while (Date.now() < deadline) {
    const result = await readJson(jobPath(homeDir, jobId, 'result')).catch(() => null)
    if (result) {
      validateJobAccess(result, jobId, nonce)
      return result
    }
    lastState = await readJson(jobPath(homeDir, jobId, 'state')).catch(() => lastState)
    if (lastState && FINAL_STATES.has(lastState.status)) {
      throw accessError(lastState.status, `Local job ended without result: ${lastState.status}`)
    }
    await delay(pollMs)
  }
  await writeJobState({ homeDir, jobId, nonce, status: JOB_STATES.TIMED_OUT, actor: 'tokenless-cli' })
  throw accessError('job_timeout', 'Timed out waiting for local Tokenless job result.')
}

export async function installNativeHost({
  homeDir = tokenlessHome(),
  manifestHome = os.homedir(),
  extensionId,
  browsers = ['chrome', 'chrome-for-testing', 'chrome-for-testing-legacy', 'chromium', 'edge', 'arc'],
  nodePath = process.execPath,
  packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url))),
} = {}) {
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

  const manifests = []
  if (extensionId) {
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: 'Tokenless native messaging host',
      path: executable,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    }
    for (const browser of browsers) {
      for (const dir of nativeMessagingHostDirs(browser, manifestHome)) {
        await fs.mkdir(dir, { recursive: true, mode: 0o755 })
        const manifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`)
        await writeJsonAtomic(manifestPath, manifest, 0o644)
        manifests.push(manifestPath)
      }
    }
  }

  return { executable, manifests }
}

export function nativeMessagingHostDir(browser, home = os.homedir()) {
  return nativeMessagingHostDirs(browser, home)[0] ?? null
}

export function nativeMessagingHostDirs(browser, home = os.homedir()) {
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
    }
    return roots[browser] ? [path.join(home, ...roots[browser])] : []
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
  }
  return roots[browser] ? [path.join(home, ...roots[browser])] : []
}

export function buildTaskUrl({ extensionId, jobId, nonce } = {}) {
  if (!extensionId) {
    throw new TypeError('extensionId is required to build a task URL.')
  }
  const params = new URLSearchParams({ jobId, nonce })
  return `chrome-extension://${extensionId}/task/task.html?${params.toString()}`
}

export function jobPath(homeDir, jobId, kind) {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(jobId)) {
    throw new Error('Invalid jobId.')
  }
  return path.join(jobsDir(homeDir), `${jobId}.${kind}.json`)
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function writeJsonAtomic(file, payload, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.${createJobId()}.tmp`
  let handle
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

function validateJobAccess(payload, jobId, nonce) {
  if (payload?.protocol !== LOCAL_JOB_PROTOCOL_VERSION) {
    throw accessError('unsupported_protocol', 'Local job protocol is not supported.')
  }
  if (payload.jobId !== jobId || payload.nonce !== nonce) {
    throw accessError('job_access_denied', 'Local job nonce does not match.')
  }
}

function compactResult(result) {
  const text = result?.text ?? result?.read?.text ?? result?.result?.read?.text
  if (typeof text !== 'string') {
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

function validateConversationMap(payload, mapPath) {
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

function withConversationMapLock(homeDir, fn) {
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

async function withConversationMapFileLock(homeDir, fn) {
  const lockDir = `${conversationMapPath(homeDir)}.lock`
  await acquireLockDir(lockDir)
  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function acquireLockDir(lockDir) {
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
      if (error?.code !== 'EEXIST') {
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

async function resolveConversationTarget({ homeDir, provider, targetUrl, idempotencyKey } = {}) {
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

async function rememberConversationFromResult({ homeDir, request, result } = {}) {
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
  })
}

function normalizeIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string') return undefined
  const normalized = idempotencyKey.trim()
  return normalized.length > 0 ? normalized : undefined
}

function conversationMapKey(provider, idempotencyKey) {
  return `${provider}:${idempotencyKey}`
}

function providerHomeUrl(provider) {
  const homeUrls = {
    chatgpt: 'https://chatgpt.com/',
    gemini: 'https://gemini.google.com/app',
    claude: 'https://claude.ai/new',
  }
  return homeUrls[provider] ?? undefined
}

function providerForUrl(url) {
  const parsed = typeof url === 'string' ? safeUrl(url) : url
  const host = parsed?.hostname?.toLowerCase()
  if (host === 'chatgpt.com' || host === 'chat.openai.com') return 'chatgpt'
  if (host === 'gemini.google.com') return 'gemini'
  if (host === 'claude.ai') return 'claude'
  return null
}

function isConversationUrl(provider, url) {
  if (provider === 'chatgpt') return /^\/c\/[^/]+/.test(url.pathname)
  if (provider === 'gemini') return /^\/app\/[^/]+/.test(url.pathname)
  if (provider === 'claude') return /^\/chat\/[^/]+/.test(url.pathname)
  return false
}

function providerConversationId(provider, url) {
  if (provider === 'chatgpt') return url.pathname.split('/')[2] || null
  if (provider === 'gemini') return url.pathname.split('/')[2] || null
  if (provider === 'claude') return url.pathname.split('/')[2] || null
  return null
}

function canonicalProviderUrl(url) {
  return `${url.origin}${url.pathname}`
}

function safeUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'local_job_error',
    message: typeof error?.message === 'string' ? error.message : 'Local Tokenless job failed.',
    retryable: Boolean(error?.retryable),
  }
}

function accessError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function localStateError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
