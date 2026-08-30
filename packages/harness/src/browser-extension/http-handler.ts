import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AgentRunIntervention, JsonValue, WebAgentHarness } from '../contracts.js'
import { isBrowserPageObservation, type BrowserActionResultRequest } from './contracts.js'
import { BrowserExtensionBroker, type BrowserExtensionAuth } from './broker.js'

const EXTENSION_PREFIX = '/v1/harness/browser-extension'
const DASHBOARD_PREFIX = '/v1/private/agent/browser-extension'
const MAX_BODY_BYTES = 32 * 1024 * 1024

type JsonRecord = Record<string, unknown>

export type BrowserExtensionHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
) => Promise<boolean>

export function createBrowserExtensionHttpHandler(options: {
  broker: BrowserExtensionBroker
  harness: WebAgentHarness
  tokenlessHome: string
  baseUrl: string
}): BrowserExtensionHttpHandler {
  const expectedHost = new URL(options.baseUrl).host

  return async (request, response, method, url) => {
    const dashboardRoute = url.pathname.startsWith(DASHBOARD_PREFIX)
    const extensionRoute = url.pathname.startsWith(EXTENSION_PREFIX)
    if (!dashboardRoute && !extensionRoute) return false

    let extensionOrigin: string | undefined
    try {
      requireExactHost(request, expectedHost)
      if (extensionRoute) {
        const origin = requireExtensionOrigin(request)
        extensionOrigin = origin
        writeCors(response, origin, request)
        if (method === 'OPTIONS') {
          response.writeHead(204)
          response.end()
          return true
        }
      }

      if (dashboardRoute) {
        return await handleDashboard(options.broker, request, response, method, url)
      }
      return await handleExtension(options, request, response, method, url, extensionOrigin!)
    } catch (error) {
      if (extensionOrigin) writeCors(response, extensionOrigin, request)
      writeError(response, error)
      return true
    }
  }
}

async function handleDashboard(
  broker: BrowserExtensionBroker,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
) {
  if (method === 'GET' && url.pathname === `${DASHBOARD_PREFIX}/pairings`) {
    writeJson(response, 200, { pairings: broker.listPairings() })
    return true
  }
  const match = new RegExp(`^${DASHBOARD_PREFIX}/pairings/([^/]+)(?:/(approve|revoke))?$`, 'u').exec(url.pathname)
  if (!match) return false
  const pairingId = decodeURIComponent(match[1] ?? '')
  const action = match[2]
  if (method === 'GET' && action === undefined) {
    writeJson(response, 200, broker.pairingRequest(pairingId))
    return true
  }
  if (method === 'POST' && action === 'approve') {
    const body = await readJsonObject(request)
    requireExactKeys(body, ['provider', 'profileId'])
    writeJson(response, 200, broker.approvePairing(pairingId, {
      provider: requiredString(body.provider, 'provider'),
      profileId: requiredString(body.profileId, 'profileId'),
    }))
    return true
  }
  if (method === 'POST' && action === 'revoke') {
    await requireEmptyObject(request)
    writeJson(response, 200, broker.revokePairing(pairingId))
    return true
  }
  return false
}

async function handleExtension(
  options: {
    broker: BrowserExtensionBroker
    harness: WebAgentHarness
    tokenlessHome: string
    baseUrl: string
  },
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
  extensionOrigin: string,
) {
  const relative = url.pathname.slice(EXTENSION_PREFIX.length) || '/'
  if (method === 'POST' && relative === '/pairings') {
    const body = await readJsonObject(request)
    requireExactKeys(body, ['extensionId', 'extensionVersion'])
    const extensionId = requiredString(body.extensionId, 'extensionId')
    requireOriginIdentity(extensionOrigin, extensionId)
    writeJson(response, 201, options.broker.createPairing({
      extensionId,
      extensionVersion: requiredString(body.extensionVersion, 'extensionVersion'),
    }))
    return true
  }
  const pairingPoll = /^\/pairings\/([^/]+)\/poll$/u.exec(relative)
  if (method === 'POST' && pairingPoll) {
    const body = await readJsonObject(request)
    requireExactKeys(body, ['secret'])
    writeJson(response, 200, options.broker.pollPairing(
      decodeURIComponent(pairingPoll[1] ?? ''),
      requiredString(body.secret, 'secret'),
    ))
    return true
  }

  const auth = extensionAuth(options.broker, request, extensionOrigin)
  if (method === 'GET' && relative === '/connection') {
    writeJson(response, 200, { pairing: publicCredential(auth) })
    return true
  }
  if (method === 'DELETE' && relative === '/connection') {
    writeJson(response, 200, options.broker.revokeAuthenticated(auth))
    return true
  }
  if (method === 'POST' && relative === '/sessions') {
    const body = await readJsonObject(request)
    requireExactKeys(body, ['sessionId', 'page', 'observation', 'evidence'])
    const sessionId = requiredString(body.sessionId, 'sessionId')
    if (!isRecord(body.page) || !isBrowserPageObservation(body.observation) || !isRecord(body.evidence)) {
      throw httpError('extension_session_invalid', 'The extension session body is invalid.', 400)
    }
    const summary = options.broker.attachSession(auth, sessionId, body.page as never)
    try {
      options.broker.setObservation(auth, sessionId, body.observation)
      requireExactKeys(body.evidence, ['rawDom', 'screenshotDataUrl', 'capturedAt'])
      options.broker.recordInitialEvidence(auth, sessionId, {
        rawDom: requiredString(body.evidence.rawDom, 'evidence.rawDom'),
        screenshotDataUrl: requiredString(body.evidence.screenshotDataUrl, 'evidence.screenshotDataUrl'),
        capturedAt: requiredString(body.evidence.capturedAt, 'evidence.capturedAt'),
      })
    } catch (error) {
      options.broker.detachSession(auth, sessionId)
      throw error
    }
    writeJson(response, 201, summary)
    return true
  }
  const sessionMatch = /^\/sessions\/([^/]+)$/u.exec(relative)
  if (method === 'DELETE' && sessionMatch) {
    writeJson(response, 200, options.broker.detachSession(auth, decodeURIComponent(sessionMatch[1] ?? '')))
    return true
  }
  if (method === 'POST' && relative === '/runs') {
    const body = await readJsonObject(request)
    requireExactKeys(body, ['sessionId', 'taskPrompt'])
    const sessionId = requiredString(body.sessionId, 'sessionId')
    const taskPrompt = requiredString(body.taskPrompt, 'taskPrompt')
    if (Buffer.byteLength(taskPrompt, 'utf8') > 64 * 1024) throw httpError('extension_task_invalid', 'The task prompt is too large.', 400)
    options.broker.setTaskPrompt(auth, sessionId, taskPrompt)
    const view = await options.harness.start({
      provider: auth.credential.provider!,
      profileId: auth.credential.profileId!,
      taskPrompt: '[redacted extension task prompt]',
      stagingRoot: path.join(options.tokenlessHome, 'harness-staging'),
      maxTurns: 8,
      mcpServers: [],
      toolBinding: { kind: 'opaque', ref: sessionId },
    })
    writeJson(response, 201, options.broker.presentRun(auth, view))
    return true
  }
  const runMatch = /^\/runs\/(run_[a-f0-9]{32})(?:\/(cancel))?$/u.exec(relative)
  if (runMatch) {
    const runId = runMatch[1]!
    options.broker.authorizeRun(auth, runId)
    if (method === 'GET' && runMatch[2] === undefined) {
      const view = await options.harness.read(runId)
      if (!view) throw httpError('extension_run_missing', 'The extension run was not found.', 404)
      writeJson(response, 200, options.broker.presentRun(auth, view))
      return true
    }
    if (method === 'POST' && runMatch[2] === 'cancel') {
      await requireEmptyObject(request)
      const view = await options.harness.cancel(runId)
      writeJson(response, 200, options.broker.presentRun(auth, view))
      return true
    }
  }
  const decisionMatch = /^\/runs\/(run_[a-f0-9]{32})\/actions\/([^/]+)\/decision$/u.exec(relative)
  if (method === 'POST' && decisionMatch) {
    const runId = decisionMatch[1]!
    const actionId = decodeURIComponent(decisionMatch[2] ?? '')
    const { sessionId } = options.broker.authorizeRun(auth, runId)
    const body = await readJsonObject(request)
    requireExactKeys(body, ['approved', 'callId', 'argumentsDigest'])
    if (typeof body.approved !== 'boolean') throw httpError('extension_action_invalid', 'approved must be a boolean.', 400)
    const action = options.broker.nextAction(auth, sessionId, runId)
    if (!action || action.actionId !== actionId || action.callId !== body.callId || action.argumentsDigest !== body.argumentsDigest) {
      throw httpError('extension_action_invalid', 'The decision does not match the frozen action.', 409)
    }
    options.broker.decideAction(auth, sessionId, actionId, body.approved)
    const view = await (body.approved
      ? options.harness.resume(runId, {
        approvals: [{ callId: action.callId, argumentsDigest: action.argumentsDigest }],
      } satisfies AgentRunIntervention)
      : options.harness.cancel(runId))
    writeJson(response, 200, options.broker.presentRun(auth, view))
    return true
  }
  const actionsMatch = /^\/sessions\/([^/]+)\/actions$/u.exec(relative)
  if (method === 'GET' && actionsMatch) {
    const sessionId = decodeURIComponent(actionsMatch[1] ?? '')
    const runId = url.searchParams.get('runId') ?? undefined
    if (runId) options.broker.authorizeRun(auth, runId)
    const action = options.broker.nextAction(auth, sessionId, runId)
    if (!action) {
      response.writeHead(204)
      response.end()
    } else {
      writeJson(response, 200, action)
    }
    return true
  }
  const resultMatch = /^\/sessions\/([^/]+)\/actions\/([^/]+)\/result$/u.exec(relative)
  if (method === 'POST' && resultMatch) {
    const sessionId = decodeURIComponent(resultMatch[1] ?? '')
    const actionId = decodeURIComponent(resultMatch[2] ?? '')
    const body = await readJsonObject(request)
    requireExactKeys(body, ['runId', 'result'])
    const runId = requiredString(body.runId, 'runId')
    options.broker.authorizeRun(auth, runId)
    writeJson(response, 200, options.broker.submitActionResult(auth, sessionId, {
      actionId,
      runId,
      result: body.result as BrowserActionResultRequest['result'],
    }))
    return true
  }
  const evidenceMatch = /^\/sessions\/([^/]+)\/actions\/([^/]+)\/evidence$/u.exec(relative)
  if (method === 'POST' && evidenceMatch) {
    const sessionId = decodeURIComponent(evidenceMatch[1] ?? '')
    const actionId = decodeURIComponent(evidenceMatch[2] ?? '')
    const body = await readJsonObject(request)
    requireExactKeys(body, ['screenshotDataUrl', 'capturedAt'])
    writeJson(response, 200, options.broker.recordActionScreenshot(auth, sessionId, actionId, {
      screenshotDataUrl: requiredString(body.screenshotDataUrl, 'screenshotDataUrl'),
      capturedAt: requiredString(body.capturedAt, 'capturedAt'),
    }))
    return true
  }
  return false
}

function extensionAuth(broker: BrowserExtensionBroker, request: IncomingMessage, origin: string) {
  const header = request.headers.authorization
  const value = Array.isArray(header) ? header[0] : header
  const match = /^Bearer ([^\s]+)$/u.exec(value ?? '')
  const auth = broker.authenticate(match?.[1])
  requireOriginIdentity(origin, auth.credential.extensionId)
  return auth
}

function publicCredential(auth: BrowserExtensionAuth) {
  const { credential: _credential, credentialHash: _hash, credentialVersion: _version, ...summary } = auth.credential
  return summary
}

async function readJsonObject(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) throw httpError('extension_body_too_large', 'The extension request body is too large.', 413)
    chunks.push(bytes)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) throw new Error('body must be an object')
    return value
  } catch {
    throw httpError('extension_json_invalid', 'The extension request body must be a JSON object.', 400)
  }
}

async function requireEmptyObject(request: IncomingMessage) {
  const body = await readJsonObject(request)
  requireExactKeys(body, [])
}

function requireExactKeys(value: JsonRecord, allowed: readonly string[]) {
  const accepted = new Set(allowed)
  if (Object.keys(value).some((key) => !accepted.has(key)) || allowed.some((key) => !Object.hasOwn(value, key))) {
    throw httpError('extension_input_invalid', 'The extension request contains missing or unknown fields.', 400)
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw httpError('extension_input_invalid', `${field} must be a nonempty string.`, 400)
  }
  return value
}

function requireExactHost(request: IncomingMessage, expectedHost: string) {
  const host = Array.isArray(request.headers.host) ? request.headers.host[0] : request.headers.host
  if (host !== expectedHost) throw httpError('extension_host_rejected', 'The loopback Host does not match the running daemon.', 403)
}

function requireExtensionOrigin(request: IncomingMessage) {
  const raw = request.headers.origin
  const origin = Array.isArray(raw) ? raw[0] : raw
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) {
    throw httpError('extension_origin_rejected', 'The request Origin is not an installed Chrome extension.', 403)
  }
  return origin
}

function requireOriginIdentity(origin: string, extensionId: string) {
  if (origin !== `chrome-extension://${extensionId}`) {
    throw httpError('extension_origin_rejected', 'The extension Origin does not match the scoped identity.', 403)
  }
}

function writeCors(response: ServerResponse, origin: string, request: IncomingMessage) {
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('access-control-max-age', '600')
  response.setHeader('vary', 'Origin')
  const privateNetwork = request.headers['access-control-request-private-network']
  if ((Array.isArray(privateNetwork) ? privateNetwork[0] : privateNetwork) === 'true') {
    response.setHeader('access-control-allow-private-network', 'true')
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function writeError(response: ServerResponse, error: unknown) {
  const value = isRecord(error) ? error : {}
  const code = typeof value.code === 'string' ? value.code : 'extension_internal_error'
  const status = typeof value.status === 'number'
    ? value.status
    : code === 'extension_auth_required' ? 401
      : code === 'extension_auth_rejected' || code.endsWith('_rejected') ? 403
        : code.endsWith('_missing') || code.endsWith('_expired') ? 404
          : code.startsWith('extension_') ? 400
            : 500
  writeJson(response, status, {
    error: {
      code,
      message: status === 500 ? 'Tokenless Harness extension operation failed.' : error instanceof Error ? error.message : 'Extension operation failed.',
      retryable: false,
    },
  })
}

function httpError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status })
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
