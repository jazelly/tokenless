import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'

import { tokenlessPackageVersion } from '../platform-package.js'
import { DAEMON_CONTROL_API_REVISION } from '../schema-ids.js'
import { normalizeBrowserVisibility } from '../browser-visibility.js'
import { listProviderInstances } from '../providers/registry.js'
import {
  MANAGED_PLAYWRIGHT_JOB_ACTION,
  validateManagedPlaywrightJobRequest,
} from '../playwright/job-contract.js'
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
import { JobStore, WebAiRequestCancelledError, WebAiRequestRefConflictError, publicView, type ExecutionBackend, type JobStatus } from './job-store.js'
import { TokenlessApplicationServices } from '../application/services.js'
import { TokenlessUiServer } from './ui-server.js'
import { UiSessionManager } from './ui-session.js'
import { OutputSavingsProcessor } from '../output-savings/processor.js'
import { WebAiInteractionV0Adapter } from './web-ai-interaction-v0.js'
import {
  ApiProxyAdapter,
  ApiProxyError,
  anthropicMessageBody,
  anthropicStreamFrames,
  apiProxyDisabled,
  apiProxyErrorBody,
  apiProxyModelList,
  openAiCompletionBody,
  openAiResponseStreamFrames,
  openAiStreamFrames,
  type ApiProxyDialect,
} from './api-proxy.js'
import type { G4fServiceProcess } from '../g4f/index.js'
import { handleG4fApiRequest } from './g4f-api.js'
import { parseImageAssetReference, readPersistedImageAsset } from '../playwright/image-assets.js'
import { ImageGenerationAdapter, ImageGenerationError } from './image-generation.js'

import { FeatureBenchChannelError, FeatureBenchChannelManager, type FeatureBenchChannelIssue } from './featurebench-channel.js'

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
  g4fService,
  beforeClose,
  afterStoreClose,
}: {
  store: JobStore
  host: string
  port: number
  runtimeController?: BrowserRuntimeController | undefined
  g4fService?: G4fServiceProcess | undefined
  beforeClose?: (() => Promise<void>) | undefined
  afterStoreClose?: (() => Promise<void>) | undefined
}) {
  validateLoopbackHost(host)
  let active = false
  const activate = () => {
    active = true
  }
  const deactivate = () => {
    active = false
  }
  const outputSavingsProcessor = new OutputSavingsProcessor(store)
  const featureBench = new FeatureBenchChannelManager(store, async () => await runtimeController?.wake())
  let closePromise: Promise<void> | undefined
  const close = () => {
    closePromise ??= closeServer(server, store, outputSavingsProcessor, async () => {
      await featureBench.close()
      await beforeClose?.()
    }, afterStoreClose)
    return closePromise
  }
  const startedAt = Date.now()
  let server: http.Server
  const origin = () => serverOrigin(host, serverPort(server, port))
  const uiServer = new TokenlessUiServer({
    services: new TokenlessApplicationServices({
      store,
      runtimeController,
      outputSavingsProcessor,
      origin,
      startedAt,
    }),
    sessions: new UiSessionManager(),
    origin,
  })
  const webAi = new WebAiInteractionV0Adapter(store)
  await webAi.initializeCleanup()
  const apiProxy = new ApiProxyAdapter(store, async () => await runtimeController?.wake(), g4fService?.client)
  const imageGeneration = new ImageGenerationAdapter(store, async () => await runtimeController?.wake(), g4fService?.client)
  server = http.createServer((request, response) => {
    void handleRequest(store, close, () => active, deactivate, runtimeController, g4fService, uiServer, webAi, apiProxy, imageGeneration, featureBench, request, response)
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
  outputSavingsProcessor.start()
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
    controlApiRevision: DAEMON_CONTROL_API_REVISION,
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
  deactivate: () => void,
  runtimeController: BrowserRuntimeController | undefined,
  g4fService: G4fServiceProcess | undefined,
  uiServer: TokenlessUiServer,
  webAi: WebAiInteractionV0Adapter,
  apiProxy: ApiProxyAdapter,
  imageGeneration: ImageGenerationAdapter,
  featureBench: FeatureBenchChannelManager,
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
        control_api_revision: DAEMON_CONTROL_API_REVISION,
        ready: active,
        home_dir: store.homeDir,
        pid: process.pid,
        g4f_ready: g4fService?.health.status === 'ready',
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

    if (method === 'GET' && url.pathname === '/') {
      try {
        uiServer.redirectToConsole(request, response)
      } catch (error) {
        uiServer.writeError(response, error)
      }
      return
    }

    if (url.pathname === '/ui' || url.pathname.startsWith('/ui/')) {
      try {
        await uiServer.handle(request, response, url)
      } catch (error) {
        uiServer.writeError(response, error)
      }
      return
    }

    if (url.pathname.startsWith('/ui-api/v1/')) {
      try {
        await uiServer.handle(request, response, url)
      } catch (error) {
        uiServer.writeError(response, error)
      }
      return
    }

    requireControlAuth(store, request)

    const imageAssetRoute = /^\/v1\/asset(?:\/.*)?$/u.test(url.pathname)
    if (method === 'GET' && imageAssetRoute) {
      let assetRef: string
      try {
        const segments = url.pathname.split('/').slice(3).map((segment) => decodeURIComponent(segment))
        if (segments.length !== 4) throw new Error('invalid asset path')
        assetRef = ['assets', ...segments].join('/')
      } catch {
        writeJson(response, 400, { error: { code: 'invalid_asset_reference', message: 'The image asset reference is invalid.', retryable: false } })
        return
      }
      if (!parseImageAssetReference(assetRef)) {
        writeJson(response, 400, { error: { code: 'invalid_asset_reference', message: 'The image asset reference is invalid.', retryable: false } })
        return
      }
      const asset = await readPersistedImageAsset(store.homeDir, assetRef)
      if (!asset) {
        writeJson(response, 404, { error: { code: 'asset_not_found', message: 'The requested image asset was not found.', retryable: false } })
        return
      }
      response.writeHead(200, {
        'content-type': asset.mediaType,
        'content-length': String(asset.bytes.byteLength),
        'cache-control': 'no-store',
      })
      response.end(asset.bytes)
      return
    }

    if (method === 'POST' && url.pathname === '/v1/images/generations') {
      writeJson(response, 200, await imageGeneration.generate(await readJsonObject(request)))
      return
    }

    if (await handleG4fApiRequest({
      store,
      client: g4fService?.client,
      request,
      response,
      method,
      url,
    })) return

    if (method === 'POST' && url.pathname === '/v1/featurebench/channels') {
      const body = await readJsonObject(request)
      const allowed = new Set([
        'instanceId',
        'benchmarkRunId',
        'benchmarkCommit',
        'datasetRevision',
        'provider',
        'profile',
        'executionMode',
        'model',
        'effort',
        'maxTurns',
        'expiresInMs',
        'providerTurnTimeoutMs',
      ])
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        throw invalidInput('FeatureBench channel request contains an unknown field')
      }
      writeJson(response, 200, await featureBench.issue(body as unknown as FeatureBenchChannelIssue))
      return
    }

    const apiProxyRoute = matchApiProxyRoute(method, url.pathname)
    if (apiProxyRoute) {
      await handleApiProxyRequest(apiProxy, apiProxyRoute, request, response)
      return
    }

    if (url.pathname.startsWith('/v1/web-ai/')) {
      try {
        const handled = await handleWebAiRequest(webAi, runtimeController, request, response, method, url)
        if (handled) return
        writeWebAiError(response, invalidInput('web ai route is invalid'))
      } catch (error) {
        writeWebAiError(response, error)
      }
      return
    }

    if (method === 'POST' && url.pathname === '/control/dashboard') {
      const rawBody = await readBody(request)
      const body = rawBody ? parseJsonObject(rawBody) : {}
      if (Object.keys(body).some((key) => key !== 'profile_id' && key !== 'open')) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      const profileId = optionalString(body.profile_id)
      const url = uiServer.consoleUrl(profileId)
      const opened = body.open === true && profileId
        ? await runtimeController?.openControlPlane(profileId, url)
        : null
      writeJson(response, 200, { url, opened })
      return
    }

    if (method === 'GET' && url.pathname === '/control/browser-runtime/status') {
      writeJson(response, 200, browserRuntimeStatus(runtimeController))
      return
    }
    if (method === 'POST' && url.pathname === '/control/browser-runtime/quiesce') {
      writeJson(response, 200, await browserRuntimeQuiesce(runtimeController))
      return
    }
    if (method === 'POST' && url.pathname === '/control/browser-runtime/open-profile') {
      const body = await readJsonObject(request)
      const openFields = new Set(['profile_id', 'browser_visibility'])
      if (Object.keys(body).some((key) => !openFields.has(key))) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      writeJson(response, 200, await browserRuntimeOpenProfile(
        runtimeController,
        requiredString(body.profile_id, 'profile_id'),
        requiredBrowserVisibility(body.browser_visibility),
      ))
      return
    }
    if (method === 'POST' && url.pathname === '/control/browser-runtime/open-provider-tabs') {
      const body = await readJsonObject(request)
      const openFields = new Set(['profile_id', 'browser_visibility', 'providers'])
      if (Object.keys(body).some((key) => !openFields.has(key))) {
        throw invalidInput('request body must be valid JSON: unknown field')
      }
      writeJson(response, 200, await browserRuntimeOpenProviderTabs(
        runtimeController,
        requiredString(body.profile_id, 'profile_id'),
        requiredProviderList(body.providers),
        requiredBrowserVisibility(body.browser_visibility),
      ))
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
      const action = requiredString(body.action, 'action')
      const executionBackend = optionalExecutionBackend(body.execution_backend)
      if (executionBackend === 'playwright' && !supportedProviderSet().has(provider)) {
        throw invalidInput(`unsupported playwright provider: ${provider}`)
      }
      const rawRequestJson = requireField(body, 'request_json')
      const requestJson = action === MANAGED_PLAYWRIGHT_JOB_ACTION && hasManagedPlaywrightProtocol(rawRequestJson)
        ? validateManagedPlaywrightRequestInput(rawRequestJson)
        : rawRequestJson
      const job = store.createJob({
        provider,
        action,
        request_json: requestJson,
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

    if (method === 'GET' && url.pathname === '/provider-mappings/resolve') {
      const mapping = store.resolveProviderMapping({
        provider: requiredQueryString(url.searchParams.get('provider'), 'provider'),
        profile_id: requiredQueryString(url.searchParams.get('profile_id'), 'profile_id'),
        project_name: requiredQueryString(url.searchParams.get('project_name'), 'project_name'),
        task_id: optionalQueryString(url.searchParams.get('task_id')),
      })
      writeJson(response, 200, { mapping })
      return
    }

    if (method === 'GET' && url.pathname === '/provider-conversations/resolve') {
      const mapping = store.resolveProviderTaskConversation({
        provider: requiredQueryString(url.searchParams.get('provider'), 'provider'),
        profile_id: requiredQueryString(url.searchParams.get('profile_id'), 'profile_id'),
        task_id: requiredQueryString(url.searchParams.get('task_id'), 'task_id'),
      })
      writeJson(response, 200, { mapping })
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

    if (method === 'GET' && url.pathname === '/provider-capacity') {
      const provider = requiredQueryString(url.searchParams.get('provider'), 'provider')
      const projection = store.projectProviderCapacity({
        provider,
        profile_id: requiredQueryString(url.searchParams.get('profile_id'), 'profile_id'),
        access_class: requiredQueryString(url.searchParams.get('access_class'), 'access_class'),
        tier_label: optionalQueryString(url.searchParams.get('tier_label')),
        subscription_label: optionalQueryString(url.searchParams.get('subscription_label')),
        request_json: {
          provider,
          actions: [{ action: 'prompt.submit', payload: {} }],
        },
      })
      writeJson(response, 200, projection)
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
      deactivate()
      writeJson(response, 200, { ok: true, status: 'shutting_down', pid: process.pid })
      setImmediate(() => {
        void closeDaemon()
      })
      return
    }

    writeJson(response, 404, { error: { message: 'not found' } })
  } catch (error) {
    if (error instanceof ImageGenerationError) {
      writeJson(response, error.status, {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      })
      return
    }
    const directApiStatus = (error as { status?: unknown })?.status
    const directApiCode = (error as { code?: unknown })?.code
    if (
      typeof directApiStatus === 'number' &&
      typeof directApiCode === 'string' &&
      directApiCode.startsWith('g4f_')
    ) {
      writeJson(response, directApiStatus, {
        error: {
          code: directApiCode,
          message: error instanceof Error ? error.message : 'The direct G4F request was rejected.',
        },
      })
      return
    }
    if (error instanceof FeatureBenchChannelError) {
      writeJson(response, error.status, { error: { code: error.code, message: error.message, retryable: error.status >= 500, details: { category: error.category } } })
      return
    }
    if (error instanceof BodyLimitExceededError) {
      writeText(response, 413, BODY_LIMIT_EXCEEDED_MESSAGE)
      return
    }
    writeDaemonError(response, toDaemonError(error))
  }
}

async function handleWebAiRequest(
  webAi: WebAiInteractionV0Adapter,
  runtimeController: BrowserRuntimeController | undefined,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
) {
  if (method === 'POST' && url.pathname === '/v1/web-ai/bindings') {
    writeJson(response, 200, await webAi.bind(await readJsonObject(request)))
    return true
  }
  const bindingRoute = /^\/v1\/web-ai\/bindings\/([^/]+)(?:\/(capabilities|attachments|turns))?$/.exec(url.pathname)
  if (bindingRoute) {
    const bindingRef = decodeURIComponent(bindingRoute[1] ?? '')
    const action = bindingRoute[2] ?? null
    if (method === 'GET' && action === 'capabilities') {
      writeJson(response, 200, await webAi.capabilities(bindingRef))
      return true
    }
    if (method === 'POST' && action === 'attachments') {
      try {
        writeJson(response, 200, { attachment: await webAi.stage(
          bindingRef,
          request,
          request.headers['content-type'] as string | undefined,
          request.headers['x-tokenless-attachment-name'] as string | undefined,
          request.headers['x-tokenless-bundle-with'] as string | undefined,
        ) })
      } catch {
        throw invalidInput('web ai attachment could not be staged')
      }
      return true
    }
    if (method === 'POST' && action === 'turns') {
      const turn = await webAi.start(bindingRef, await readJsonObject(request))
      await runtimeController?.wake()
      writeJson(response, 200, { turn })
      return true
    }
  }
  const requestRoute = /^\/v1\/web-ai\/requests\/([^/]+)\/cancel$/.exec(url.pathname)
  if (requestRoute && method === 'POST') {
    const rawBody = await readBody(request)
    if (rawBody && Object.keys(parseJsonObject(rawBody)).length > 0) throw invalidInput('web ai request cancel body must be empty')
    writeJson(response, 200, await webAi.cancelRequest(decodeURIComponent(requestRoute[1] ?? '')))
    return true
  }
  const turnRoute = /^\/v1\/web-ai\/turns\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname)
  if (turnRoute) {
    const turnRef = decodeURIComponent(turnRoute[1] ?? '')
    const action = turnRoute[2] ?? null
    if (method === 'GET' && action === null) {
      writeJson(response, 200, { turn: await webAi.read(turnRef) })
      return true
    }
    if (method === 'POST' && action === 'cancel') {
      const rawBody = await readBody(request)
      if (rawBody && Object.keys(parseJsonObject(rawBody)).length > 0) throw invalidInput('web ai cancel body must be empty')
      writeJson(response, 200, { turn: await webAi.cancel(turnRef) })
      return true
    }
  }
  return false
}

function writeWebAiError(response: ServerResponse, error: unknown) {
  const daemonError = toDaemonError(error)
  const requestRefConflict = error instanceof WebAiRequestRefConflictError
  const requestCancelled = error instanceof WebAiRequestCancelledError
  const invalid = daemonError.kind === 'invalid_input'
  writeJson(response, requestRefConflict || requestCancelled ? 409 : invalid ? 400 : 500, {
    error: {
      code: requestRefConflict ? 'web_ai_request_ref_conflict' : requestCancelled ? 'web_ai_request_cancelled' : invalid ? 'invalid_input' : 'local_http_error',
      message: requestRefConflict ? 'The request reference is already bound to a different request.' : requestCancelled ? 'The request reference was cancelled before a turn could be created.' : invalid ? 'The local Web AI request was rejected.' : 'The local Web AI service encountered an error.',
      retryable: requestRefConflict || requestCancelled ? false : !invalid,
    },
  })
}

function hasManagedPlaywrightProtocol(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'protocol'))
}

function validateManagedPlaywrightRequestInput(value: unknown) {
  try {
    return validateManagedPlaywrightJobRequest(value)
  } catch (error) {
    throw invalidInput(`request_json is invalid: ${error instanceof Error ? error.message : String(error)}`)
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

async function browserRuntimeOpenProfile(
  runtimeController: BrowserRuntimeController | undefined,
  profileId: string,
  browserVisibility: ReturnType<typeof requiredBrowserVisibility>
) {
  if (!runtimeController) throw invalidInput('browser runtime control is unavailable')
  return await runtimeController.openProfile(profileId, browserVisibility)
}

async function browserRuntimeOpenProviderTabs(
  runtimeController: BrowserRuntimeController | undefined,
  profileId: string,
  providers: readonly string[],
  browserVisibility: ReturnType<typeof requiredBrowserVisibility>,
) {
  if (!runtimeController) throw invalidInput('browser runtime control is unavailable')
  return await runtimeController.openProviderTabs(profileId, providers, browserVisibility)
}

function requiredBrowserVisibility(value: unknown) {
  const browserVisibility = normalizeBrowserVisibility(value)
  if (!browserVisibility) throw invalidInput('browser_visibility must be auto, headed, or headless')
  return browserVisibility
}

function requiredProviderList(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidInput('providers must be a non-empty array')
  }
  const supported = supportedProviderSet()
  const providers: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !supported.has(entry)) {
      throw invalidInput('providers includes an unsupported provider')
    }
    if (providers.includes(entry)) throw invalidInput('providers must not contain duplicates')
    providers.push(entry)
  }
  return providers
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

type ApiProxyRoute =
  | { kind: 'completion'; dialect: ApiProxyDialect }
  | { kind: 'response' }
  | { kind: 'models' }

/**
 * The bare `/v1/models` and `/v1/chat/completions` paths let an unmodified
 * OpenAI SDK work with nothing but a `baseURL` override, so OpenAI is the
 * default dialect. The prefixed paths stay authoritative and are the only way
 * to reach Anthropic.
 */
function matchApiProxyRoute(method: string, pathname: string): ApiProxyRoute | null {
  if (method === 'POST' && (pathname === '/v1/openai/chat/completions' || pathname === '/v1/chat/completions')) {
    return { kind: 'completion', dialect: 'openai' }
  }
  if (method === 'POST' && (pathname === '/v1/openai/responses' || pathname === '/v1/responses')) {
    return { kind: 'response' }
  }
  if (method === 'POST' && pathname === '/v1/anthropic/messages') return { kind: 'completion', dialect: 'anthropic' }
  if (method === 'GET' && (pathname === '/v1/openai/models' || pathname === '/v1/models')) return { kind: 'models' }
  return null
}

async function handleApiProxyRequest(
  apiProxy: ApiProxyAdapter,
  route: ApiProxyRoute,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const dialect = route.kind === 'completion' ? route.dialect : 'openai'
  const requestLifetime = apiProxyRequestLifetime(request, response)
  let requestedModel = 'unknown'
  try {
    if (!await apiProxy.enabled()) throw apiProxyDisabled()
    if (route.kind === 'models') {
      writeJson(response, 200, apiProxyModelList())
      return
    }
    const body = await readApiProxyJson(request)
    requestedModel = typeof body.model === 'string' ? body.model : 'unknown'
    if (route.kind === 'response') {
      const result = await apiProxy.respond(body, requestLifetime.signal)
      if (result.stream) {
        writeApiProxyStream(response, openAiResponseStreamFrames(result.body))
        return
      }
      writeJson(response, 200, result.body)
      return
    }
    const completion = await apiProxy.complete(dialect, body, requestLifetime.signal)
    if (body.stream === true) {
      writeApiProxyStream(response, dialect === 'openai'
        ? openAiStreamFrames(completion, requestedModel)
        : anthropicStreamFrames(completion, requestedModel))
      return
    }
    writeJson(response, 200, dialect === 'openai'
      ? openAiCompletionBody(completion, requestedModel)
      : anthropicMessageBody(completion, requestedModel))
  } catch (error) {
    writeApiProxyError(response, dialect, error)
  } finally {
    requestLifetime.dispose()
  }
}

function writeApiProxyError(response: ServerResponse, dialect: ApiProxyDialect, error: unknown) {
  if (response.destroyed || response.writableEnded) return
  if (error instanceof ApiProxyError) {
    writeJson(response, error.status, apiProxyErrorBody(dialect, error.code, error.message, error.status, error.param))
    return
  }
  const daemonError = toDaemonError(error)
  const status = daemonErrorStatus(daemonError)
  const { error: envelope } = daemonErrorBody(daemonError)
  writeJson(response, status, apiProxyErrorBody(
    dialect,
    typeof envelope.code === 'string' ? envelope.code : 'api_proxy_failed',
    // A 5xx is a local daemon fault, so the caller gets a stable sentence
    // instead of internal store or filesystem detail.
    status >= 500 ? 'The local Tokenless daemon encountered an error.' : daemonError.message,
    status,
  ))
}

/**
 * A browser-paced completion outlives many client timeouts, so the adapter needs
 * to know the caller has gone away in order to report a disconnect rather than
 * waiting out the full deadline.
 */
function apiProxyRequestLifetime(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const requestClosed = () => {
    if (!request.complete) abort()
  }
  const responseClosed = () => {
    if (!response.writableEnded) abort()
  }
  request.once('aborted', abort)
  request.once('close', requestClosed)
  response.once('close', responseClosed)
  if (request.aborted || request.destroyed && !request.complete) abort()
  return {
    signal: controller.signal,
    dispose() {
      request.off('aborted', abort)
      request.off('close', requestClosed)
      response.off('close', responseClosed)
    },
  }
}

async function readApiProxyJson(request: IncomingMessage) {
  let raw: string
  try {
    raw = await readBody(request)
  } catch (error) {
    if (error instanceof BodyLimitExceededError) {
      throw new ApiProxyError(413, 'request_too_large', 'Request body exceeds the 2 MiB limit.')
    }
    throw error
  }
  if (!raw) throw new ApiProxyError(400, 'invalid_json', 'Request body must be a JSON object.')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiProxyError(400, 'invalid_json', 'Request body must be a JSON object.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiProxyError(400, 'invalid_request_error', 'Request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function writeApiProxyStream(response: ServerResponse, frames: readonly string[]) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  for (const frame of frames) response.write(frame)
  response.end()
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

function requiredQueryString(value: string | null, field: string) {
  if (value === null || value.trim() === '') throw invalidInput(`missing query parameter ${field}`)
  return value
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
  outputSavingsProcessor: OutputSavingsProcessor,
  beforeClose: (() => Promise<void>) | undefined,
  afterStoreClose: (() => Promise<void>) | undefined
) {
  const results = await Promise.allSettled([
    outputSavingsProcessor.stop(),
  ])
  results.push(...await Promise.allSettled([beforeClose?.() ?? Promise.resolve()]))
  results.push(...await Promise.allSettled([new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })]))
  store.close()
  results.push(...await Promise.allSettled([afterStoreClose?.() ?? Promise.resolve()]))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
