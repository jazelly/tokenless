import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'

import { tokenlessPackageVersion } from '../platform-package.js'
import { listProviderInstances } from '../providers/registry.js'
import {
  daemonReadyProof,
  isCanonicalReadyChallenge,
  READY_CHALLENGE_BYTES,
} from './ready-proof.js'
import type { BrowserRuntimeController } from './browser-runtime-controller.js'
import {
  controlAuthMissing,
  controlAuthRejected,
  daemonErrorBody,
  daemonErrorStatus,
  invalidInput,
  nonLoopbackBind,
  toDaemonError,
  type DaemonError,
} from './errors.js'
import { JobStore, publicView, type ExecutionBackend, type JobStatus } from './job-store.js'

export type DaemonServer = {
  activate(): void
  close(): Promise<void>
  server: http.Server
  store: JobStore
  host: string
  port: number
  origin: string
}

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024
const BODY_LIMIT_EXCEEDED_MESSAGE = 'Failed to buffer the request body: length limit exceeded'

type JsonRecord = Record<string, unknown>

class BodyLimitExceededError extends Error {
  constructor() {
    super(BODY_LIMIT_EXCEEDED_MESSAGE)
    this.name = 'BodyLimitExceededError'
  }
}

export async function serveHttp({
  store,
  host,
  port,
  runtimeController,
  beforeClose,
}: {
  store: JobStore
  host: string
  port: number
  runtimeController?: BrowserRuntimeController | undefined
  beforeClose?: (() => Promise<void>) | undefined
}) {
  validateLoopbackHost(host)
  let active = false
  const activate = () => {
    active = true
  }
  let closePromise: Promise<void> | undefined
  const close = () => {
    closePromise ??= closeServer(server, store, beforeClose)
    return closePromise
  }
  const server = http.createServer((request, response) => {
    void handleRequest(store, close, () => active, runtimeController, request, response)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  return {
    activate,
    server,
    store,
    host,
    port: serverPort(server, port),
    origin: serverOrigin(host, serverPort(server, port)),
    close,
  } satisfies DaemonServer
}

export function validateLoopbackHost(host: string) {
  const ip = net.isIP(host)
  const loopback = host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    (ip === 4 && host.startsWith('127.')) ||
    (ip === 6 && host === '::1')
  if (!loopback) throw nonLoopbackBind(host)
}

export function daemonBuildInfo(binary: string) {
  return {
    binary,
    version: tokenlessPackageVersion(),
    platform: process.platform === 'darwin' ? 'darwin' : process.platform,
    arch: process.arch === 'x64' ? 'x64' : process.arch,
  }
}

function serverPort(server: http.Server, requestedPort: number) {
  const address = server.address()
  if (address && typeof address !== 'string') return address.port
  return requestedPort
}

function serverOrigin(host: string, port: number) {
  const normalizedHost = host === '::1' || host === '[::1]' ? '[::1]' : host
  return `http://${normalizedHost}:${port}`
}

async function handleRequest(
  store: JobStore,
  closeDaemon: () => Promise<void>,
  isActive: () => boolean,
  runtimeController: BrowserRuntimeController | undefined,
  request: IncomingMessage,
  response: ServerResponse
) {
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1')
    const method = request.method || 'GET'
    if (method === 'GET' && url.pathname === '/ready') {
      const challenge = url.searchParams.get('challenge') ?? ''
      validateReadyChallenge(challenge)
      const active = isActive()
      writeJson(response, active ? 200 : 503, {
        version: tokenlessPackageVersion(),
        ready: active,
        home_dir: store.homeDir,
        pid: process.pid,
        proof: daemonReadyProof(store.controlToken(), challenge, store.homeDir),
      })
      return
    }

    if (!isActive()) {
      writeJson(response, 503, {
        error: {
          code: 'daemon_starting',
          message: 'Tokenless daemon startup is not complete.',
          retryable: true,
        },
      })
      return
    }

    requireControlAuth(store, request)

    if (method === 'GET' && url.pathname === '/control/browser-runtime/status') {
      writeJson(response, 200, browserRuntimeStatus(runtimeController))
      return
    }
    if (method === 'POST' && url.pathname === '/control/browser-runtime/quiesce') {
      writeJson(response, 200, await browserRuntimeQuiesce(runtimeController))
      return
    }

    if (method === 'POST' && url.pathname === '/jobs') {
      const body = await readJsonObject(request)
      const createJobFields = new Set([
        'provider',
        'action',
        'request_json',
        'execution_backend',
        'profile_id',
        'agent_kind',
        'agent_session_id',
        'job_id',
      ])
      if (Object.keys(body).some((key) => !createJobFields.has(key))) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      const hasAgentKind = Object.hasOwn(body, 'agent_kind')
      const hasAgentSessionId = Object.hasOwn(body, 'agent_session_id')
      if (hasAgentKind !== hasAgentSessionId) {
        throw invalidInput('agent_kind and agent_session_id must be provided together')
      }
      const provider = requiredString(body.provider, 'provider')
      const executionBackend = optionalExecutionBackend(body.execution_backend)
      if (executionBackend === 'playwright' && !supportedProviderSet().has(provider)) {
        throw invalidInput(`unsupported playwright provider: ${provider}`)
      }
      const job = store.createJob({
        provider,
        action: requiredString(body.action, 'action'),
        request_json: requireField(body, 'request_json'),
        execution_backend: executionBackend,
        profile_id: optionalString(body.profile_id),
        agent_kind: hasAgentKind ? requiredString(body.agent_kind, 'agent_kind') : undefined,
        agent_session_id: hasAgentSessionId ? requiredString(body.agent_session_id, 'agent_session_id') : undefined,
        job_id: optionalString(body.job_id) ?? undefined,
      })
      if (job.execution_backend === 'playwright') await runtimeController?.wake()
      writeJson(response, 200, publicView(job))
      return
    }

    if (method === 'GET' && url.pathname === '/jobs') {
      const jobs = store.listJobs({
        status: optionalJobStatus(url.searchParams.get('status')),
        execution_backend: optionalQueryExecutionBackend(url.searchParams.get('execution_backend')),
        profile_id: optionalQueryString(url.searchParams.get('profile_id')),
        provider: optionalQueryString(url.searchParams.get('provider')),
        task_id: optionalQueryString(url.searchParams.get('task_id')),
        limit: optionalLimit(url.searchParams.get('limit')),
      })
      writeJson(response, 200, jobs.map(publicView))
      return
    }

    if (method === 'POST' && url.pathname === '/replay/drain') {
      const body = await readJsonObject(request)
      if (Object.keys(body).some((key) => key !== 'agent_kind' && key !== 'agent_session_id' && key !== 'limit')) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      const summaries = store.drainReplaySummaries({
        agent_kind: requiredString(body.agent_kind, 'agent_kind'),
        agent_session_id: requiredString(body.agent_session_id, 'agent_session_id'),
      }, optionalBodyLimit(body.limit))
      writeJson(response, 200, { jobs: summaries })
      return
    }

    const jobRoute = matchJobRoute(url.pathname)
    if (jobRoute && method === 'GET' && jobRoute.action === null) {
      writeJson(response, 200, publicView(store.getJob(jobRoute.jobId)))
      return
    }
    if (jobRoute && method === 'POST' && jobRoute.action === 'resume') {
      const body = await readJsonObject(request)
      if (Object.keys(body).some((key) => key !== 'browser_visibility')) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      if (body.browser_visibility !== 'headed') throw invalidInput('request body must be valid JSON: invalid browser_visibility')
      const job = store.resumeJob(jobRoute.jobId, { browser_visibility: 'headed' })
      await runtimeController?.wake()
      writeJson(response, 200, publicView(job))
      return
    }
    if (jobRoute && method === 'POST' && jobRoute.action === 'cancel') {
      const rawBody = await readBody(request)
      const body = rawBody ? parseJsonObject(rawBody) : {}
      writeJson(response, 200, publicView(await store.cancelJob(jobRoute.jobId, body.reason)))
      return
    }
    if (jobRoute && method === 'POST' && jobRoute.action === 'report') {
      const body = await readJsonObject(request)
      if (Object.keys(body).some((key) => key !== 'agent_kind' && key !== 'agent_session_id')) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      const result = store.markJobReported(jobRoute.jobId, {
        agent_kind: requiredString(body.agent_kind, 'agent_kind'),
        agent_session_id: requiredString(body.agent_session_id, 'agent_session_id'),
      })
      writeJson(response, 200, {
        reported: result.reported,
        job: publicView(result.job),
      })
      return
    }

    if (method === 'POST' && url.pathname === '/control/shutdown') {
      writeJson(response, 200, { ok: true, status: 'shutting_down', pid: process.pid })
      setImmediate(() => {
        void closeDaemon()
      })
      return
    }

    writeJson(response, 404, { error: { message: 'not found' } })
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      writeText(response, 413, BODY_LIMIT_EXCEEDED_MESSAGE)
      return
    }
    writeDaemonError(response, toDaemonError(error))
  }
}

function browserRuntimeStatus(runtimeController: BrowserRuntimeController | undefined) {
  return runtimeController?.status() ?? {
    status: 'stopped',
    activeProfileCount: 0,
    activeJobCount: 0,
    pid: process.pid,
  }
}

async function browserRuntimeQuiesce(runtimeController: BrowserRuntimeController | undefined) {
  return await runtimeController?.quiesce() ?? browserRuntimeStatus(runtimeController)
}

function supportedProviders() {
  return listProviderInstances()
    .filter((provider) => provider.descriptor.stage !== 'disabled')
    .map((provider) => String(provider.id))
}

function supportedProviderSet() {
  return new Set(supportedProviders())
}

function requireControlAuth(store: JobStore, request: IncomingMessage) {
  const authorization = request.headers.authorization
  if (authorization === undefined) throw controlAuthMissing()
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (!value || !value.startsWith('Bearer ')) throw controlAuthRejected()
  store.requireControlToken(value.slice('Bearer '.length))
}

async function readJsonObject(request: IncomingMessage) {
  let raw
  try {
    raw = await readBody(request)
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw invalidInput('request body must be valid JSON: Failed to buffer the request body')
    }
    throw error
  }
  if (!raw) throw invalidInput('request body must be valid JSON: missing request body')
  return parseJsonObject(raw)
}

function parseJsonObject(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object')
    }
    return parsed as JsonRecord
  } catch (error) {
    throw invalidInput(`request body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readBody(request: IncomingMessage) {
  const contentLength = request.headers['content-length']
  const declaredLength = Array.isArray(contentLength) ? contentLength[0] : contentLength
  if (declaredLength !== undefined && declaredLength !== '') {
    const length = Number(declaredLength)
    if (Number.isFinite(length) && length > MAX_HTTP_BODY_BYTES) throw new BodyLimitExceededError()
  }
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > MAX_HTTP_BODY_BYTES) throw new BodyLimitExceededError()
    chunks.push(buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  return body
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function writeText(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function writeDaemonError(response: ServerResponse, error: DaemonError) {
  writeJson(response, daemonErrorStatus(error), daemonErrorBody(error))
}

function validateReadyChallenge(challenge: string) {
  if (!isCanonicalReadyChallenge(challenge)) {
    throw invalidInput(`challenge must be canonical unpadded base64url encoding of ${READY_CHALLENGE_BYTES} bytes`)
  }
}

function matchJobRoute(pathname: string) {
  const match = /^\/jobs\/([^/]+)(?:\/([^/]+))?$/.exec(pathname)
  if (!match) return null
  const action = match[2] ?? null
  if (action !== null && !['resume', 'cancel', 'report'].includes(action)) return null
  return { jobId: decodeURIComponent(match[1] || ''), action }
}

function requireField(body: JsonRecord, field: string) {
  if (!Object.hasOwn(body, field)) throw invalidInput(`missing field ${field}`)
  return body[field]
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string') throw invalidInput(`${field} must be a string`)
  return value
}

function optionalString(value: unknown) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalidInput('optional string field must be a string')
  return value
}

function optionalQueryString(value: string | null) {
  return value === null ? undefined : value
}

function optionalLimit(value: string | null) {
  if (value === null) return undefined
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw invalidInput('query parameters are invalid: Failed to deserialize query string')
  }
  const parsed = BigInt(value)
  if (parsed > 18_446_744_073_709_551_615n) {
    throw invalidInput('query parameters are invalid: Failed to deserialize query string')
  }
  return parsed > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(parsed)
}

function optionalBodyLimit(value: unknown) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 200) {
    throw invalidInput('limit must be an integer between 1 and 200')
  }
  return Number(value)
}

function optionalJobStatus(value: string | null) {
  if (value === null) return undefined
  const statuses: JobStatus[] = ['queued', 'claimed', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled', 'timed_out']
  if (!statuses.includes(value as JobStatus)) throw invalidInput(`invalid status: ${value}`)
  return value as JobStatus
}

function optionalExecutionBackend(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (value !== 'playwright') {
    throw invalidInput(`invalid execution_backend: ${String(value)}`)
  }
  return value as ExecutionBackend
}

function optionalQueryExecutionBackend(value: string | null) {
  if (value === null) return undefined
  if (value !== 'playwright') {
    throw invalidInput('query parameters are invalid: Failed to deserialize query string')
  }
  return value
}

async function closeServer(
  server: http.Server,
  store: JobStore,
  beforeClose: (() => Promise<void>) | undefined
) {
  const httpClose = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  }).catch(() => undefined)
  const runtimeClose = beforeClose?.() ?? Promise.resolve()
  const results = await Promise.allSettled([httpClose, runtimeClose])
  store.close()
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
