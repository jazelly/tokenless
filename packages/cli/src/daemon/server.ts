import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'

import {
  DAEMON_PROTOCOL,
} from '../generated/protocol-constants.js'
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
import { JobStore, publicView, withClaimToken, type ExecutionBackend, type JobStatus } from './job-store.js'

export type DaemonServer = {
  close(): Promise<void>
  server: http.Server
  store: JobStore
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
  let closePromise: Promise<void> | undefined
  const close = () => {
    closePromise ??= closeServer(server, store, beforeClose)
    return closePromise
  }
  const server = http.createServer((request, response) => {
    void handleRequest(store, close, runtimeController, request, response)
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
    server,
    store,
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
    protocol: DAEMON_PROTOCOL,
    binary,
    version: tokenlessPackageVersion(),
    platform: process.platform === 'darwin' ? 'darwin' : process.platform,
    arch: process.arch === 'x64' ? 'x64' : process.arch,
  }
}

async function handleRequest(
  store: JobStore,
  closeDaemon: () => Promise<void>,
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
      writeJson(response, 200, {
        protocol: DAEMON_PROTOCOL,
        version: tokenlessPackageVersion(),
        ready: true,
        home_dir: store.homeDir,
        pid: process.pid,
        proof: daemonReadyProof(store.controlToken(), challenge, store.homeDir),
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
        job_id: optionalString(body.job_id) ?? undefined,
        claim_token: optionalString(body.claim_token) ?? undefined,
      })
      if (job.execution_backend === 'playwright') await runtimeController?.wake()
      writeJson(response, 200, withClaimToken(job))
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

    const jobRoute = matchJobRoute(url.pathname)
    if (jobRoute && method === 'GET' && jobRoute.action === null) {
      writeJson(response, 200, publicView(store.getJob(jobRoute.jobId)))
      return
    }
    if (jobRoute && method === 'POST' && jobRoute.action === 'claim') {
      const body = await readJsonObject(request)
      writeJson(response, 200, publicView(store.claimJob(jobRoute.jobId, requiredString(body.claim_token, 'claim_token'))))
      return
    }
    if (jobRoute && method === 'POST' && jobRoute.action === 'complete') {
      const body = await readJsonObject(request)
      const hasResult = body.result_json !== undefined && body.result_json !== null
      const hasError = body.error_json !== undefined && body.error_json !== null
      if (hasResult === hasError) throw invalidInput('pass exactly one of result_json or error_json')
      const claimToken = requiredString(body.claim_token, 'claim_token')
      const job = hasResult
        ? store.completeJob(jobRoute.jobId, claimToken, { result_json: body.result_json })
        : store.completeJob(jobRoute.jobId, claimToken, { error_json: body.error_json })
      writeJson(response, 200, publicView(job))
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

    if (method === 'POST' && url.pathname === '/control/jobs/claim-next') {
      const executionBackend = optionalQueryExecutionBackend(url.searchParams.get('execution_backend')) ?? 'legacy_extension'
      const job = store.claimNextJob(
        {
          provider: optionalQueryString(url.searchParams.get('provider')),
          action: optionalQueryString(url.searchParams.get('action')),
        },
        executionBackend,
        optionalQueryString(url.searchParams.get('profile_id')) ?? null
      )
      writeJson(response, 200, { job: job ? withClaimToken(job) : null })
      return
    }

    const controlJobRoute = matchControlJobRoute(url.pathname)
    if (controlJobRoute && method === 'POST') {
      if (controlJobRoute.action === 'cancel') {
        const rawBody = await readBody(request)
        const body = rawBody ? parseJsonObject(rawBody) : {}
        writeJson(response, 200, publicView(await store.cancelJob(controlJobRoute.jobId, body.reason)))
        return
      }
      const body = await readJsonObject(request)
      if (controlJobRoute.action === 'running') {
        writeJson(response, 200, publicView(store.markRunning(controlJobRoute.jobId, requiredString(body.claim_token, 'claim_token'))))
        return
      }
      if (controlJobRoute.action === 'waiting-for-user') {
        writeJson(response, 200, publicView(store.markWaitingForUser(
          controlJobRoute.jobId,
          requiredString(body.claim_token, 'claim_token'),
          requireField(body, 'blocker_json')
        )))
        return
      }
      if (controlJobRoute.action === 'checkpoint') {
        writeJson(response, 200, publicView(store.checkpointJob(
          controlJobRoute.jobId,
          requiredString(body.claim_token, 'claim_token'),
          requireField(body, 'checkpoint_json')
        )))
        return
      }
      if (controlJobRoute.action === 'park') {
        writeJson(response, 200, publicView(store.parkJob(
          controlJobRoute.jobId,
          requiredString(body.claim_token, 'claim_token'),
          requireField(body, 'blocker_json'),
          requireField(body, 'checkpoint_json')
        )))
        return
      }
      if (controlJobRoute.action === 'renew') {
        writeJson(response, 200, publicView(store.renewClaim(controlJobRoute.jobId, requiredString(body.claim_token, 'claim_token'))))
        return
      }
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
    protocol: DAEMON_PROTOCOL,
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
  if (action !== null && !['claim', 'complete', 'resume'].includes(action)) return null
  return { jobId: decodeURIComponent(match[1] || ''), action }
}

function matchControlJobRoute(pathname: string) {
  const match = /^\/control\/jobs\/([^/]+)\/([^/]+)$/.exec(pathname)
  if (!match) return null
  const action = match[2] ?? ''
  if (!['checkpoint', 'park', 'running', 'waiting-for-user', 'renew', 'cancel'].includes(action)) return null
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

function optionalJobStatus(value: string | null) {
  if (value === null) return undefined
  const statuses: JobStatus[] = ['queued', 'claimed', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled', 'timed_out']
  if (!statuses.includes(value as JobStatus)) throw invalidInput(`invalid status: ${value}`)
  return value as JobStatus
}

function optionalExecutionBackend(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (value !== 'legacy_extension' && value !== 'playwright') {
    throw invalidInput(`invalid execution_backend: ${String(value)}`)
  }
  return value as ExecutionBackend
}

function optionalQueryExecutionBackend(value: string | null) {
  if (value === null) return undefined
  if (value !== 'legacy_extension' && value !== 'playwright') {
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
