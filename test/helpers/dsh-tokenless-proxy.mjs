import http from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const COMPLETION_PATH = '/v1/openai/chat/completions'
const MODELS_PATH = '/v1/openai/models'
const HEADER_WAIT_BEFORE_SSE_MS = 10_000
const SSE_HEARTBEAT_MS = 15_000
const INTEROP_TOOL_NAMES = new Set(['grep', 'read', 'edit', 'bash'])

/**
 * Start the real DSH-to-Tokenless bridge used by the live DSH E2E.
 *
 * The bridge owns only caller-side adaptation that DSH's native adapter cannot
 * express: it pins the selected Tokenless managed profile and browser mode in
 * the request body. It never creates provider responses, intercepts provider
 * traffic, or records message/file contents.
 */
export async function startDshTokenlessProxy({ daemonUrl, daemonToken, profile, bridgeToken = randomBytes(24).toString('hex') }) {
  const daemon = new URL(daemonUrl)
  if (daemon.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(daemon.hostname) || daemon.username || daemon.password || daemon.pathname !== '/' || daemon.search || daemon.hash || daemon.port === '') {
    throw new Error('DSH Tokenless proxy requires a loopback Tokenless daemon origin.')
  }
  if (typeof daemonToken !== 'string' || daemonToken.length === 0) throw new Error('DSH Tokenless proxy requires a daemon token.')
  if (typeof profile !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(profile)) throw new Error('DSH Tokenless proxy profile is invalid.')
  if (typeof bridgeToken !== 'string' || bridgeToken.length < 32) throw new Error('DSH Tokenless proxy bridge token is invalid.')

  const observations = []
  const server = http.createServer((request, response) => {
    void handleRequest({ request, response, daemon, daemonToken, profile, bridgeToken, observations })
  })
  server.requestTimeout = 1_900_000
  server.timeout = 1_900_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('DSH Tokenless proxy did not receive a TCP port.')
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/openai`,
    bridgeToken,
    observations: () => structuredClone(observations),
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

async function handleRequest({ request, response, daemon, daemonToken, profile, bridgeToken, observations }) {
  try {
    if (!authorized(request.headers.authorization, bridgeToken)) {
      writeError(response, 401, 'dsh_proxy_auth_rejected')
      return
    }
    const method = request.method ?? 'GET'
    const pathname = new URL(request.url ?? '/', 'http://dsh-tokenless-proxy.local').pathname
    if (method === 'GET' && pathname === MODELS_PATH) {
      await forward({ request, response, daemon, daemonToken, pathname, body: undefined, observations })
      return
    }
    if (method !== 'POST' || pathname !== COMPLETION_PATH) {
      writeError(response, 404, 'dsh_proxy_route_not_found')
      return
    }
    const body = await readJsonObject(request)
    const forwardedBody = restrictToolCatalog(body)
    const requestObservation = summarizeRequest(forwardedBody, profile)
    const forwarded = {
      ...forwardedBody,
      tokenless: { execution_mode: 'browser', profile },
    }
    const observation = { request: requestObservation, response: null }
    observations.push(observation)
    await forward({ request, response, daemon, daemonToken, pathname, body: forwarded, observation })
  } catch (error) {
    if (!response.headersSent) writeError(response, 400, 'dsh_proxy_request_invalid')
    else response.destroy()
  }
}

function restrictToolCatalog(body) {
  if (!Array.isArray(body.tools)) return body
  return {
    ...body,
    tools: body.tools.filter((tool) => INTEROP_TOOL_NAMES.has(tool?.function?.name)),
  }
}

async function forward({ request, response, daemon, daemonToken, pathname, body, observation }) {
  const controller = new AbortController()
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  const upstreamPromise = requestDaemon({
    daemon,
    pathname,
    method: request.method,
    headers: {
      authorization: `Bearer ${daemonToken}`,
      accept: request.headers.accept ?? 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body,
    signal: controller.signal,
  })
  let headersSentEarly = false
  let heartbeat
  try {
    let upstream
    if (observation?.request.stream === true) {
      const first = await resolveBeforeTimeout(upstreamPromise, HEADER_WAIT_BEFORE_SSE_MS)
      if (first.timedOut) {
        headersSentEarly = true
        writeSseHeaders(response)
        response.write(': tokenless-dsh-proxy-keepalive\n\n')
        heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(': tokenless-dsh-proxy-keepalive\n\n')
        }, SSE_HEARTBEAT_MS)
        upstream = await upstreamPromise
      } else {
        upstream = first.value
      }
    } else {
      upstream = await upstreamPromise
    }

    const status = upstream.statusCode ?? 502
    const contentType = headerValue(upstream, 'content-type') ?? 'application/json'
    if (!contentType.includes('text/event-stream')) {
      const bytes = await readIncomingBody(upstream)
      if (observation) observation.response = summarizeJsonResponse(status, contentType, bytes)
      if (headersSentEarly) {
        response.end()
      } else {
        response.writeHead(status, { 'content-type': contentType, 'content-length': bytes.length })
        response.end(bytes)
      }
      return
    }

    const streamObservation = {
      status,
      contentType,
      frames: 0,
      invalidFrames: 0,
      done: false,
      finishReasons: [],
      toolCallNames: [],
      toolCallArgumentDigests: [],
    }
    if (observation) observation.response = streamObservation
    if (!headersSentEarly) writeSseHeaders(response, status, contentType)
    let pending = ''
    for await (const chunk of upstream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      response.write(bytes)
      pending += bytes.toString('utf8')
      pending = consumeSseLines(pending, streamObservation)
    }
    if (pending.trim() !== '') consumeSseLines(`${pending}\n`, streamObservation)
    response.end()
  } catch {
    if (!response.headersSent) writeError(response, 502, 'dsh_proxy_upstream_unavailable')
    else response.destroy()
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat)
  }
}

function writeSseHeaders(response, status = 200, contentType = 'text/event-stream') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function headerValue(response, name) {
  const value = response.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readIncomingBody(response) {
  const chunks = []
  for await (const chunk of response) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function resolveBeforeTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    promise.then((value) => finish({ timedOut: false, value }), fail)
  })
}

function requestDaemon({ daemon, pathname, method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const serialized = body === undefined ? null : JSON.stringify(body)
    const request = http.request({
      hostname: daemon.hostname,
      port: daemon.port,
      path: pathname,
      method,
      headers: {
        ...headers,
        ...(serialized === null ? {} : { 'content-length': Buffer.byteLength(serialized) }),
      },
    })
    let settled = false
    const cleanup = () => signal.removeEventListener('abort', abort)
    const settle = (callback) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const abort = () => request.destroy(new Error('dsh proxy daemon request aborted'))
    request.once('response', (response) => settle(() => resolve(response)))
    request.once('error', (error) => settle(() => reject(error)))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    if (serialized !== null) request.write(serialized)
    request.end()
  })
}

function consumeSseLines(buffer, observation) {
  const lines = buffer.split(/\r?\n/u)
  const remainder = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload === '[DONE]') {
      observation.done = true
      continue
    }
    observation.frames += 1
    try {
      const value = JSON.parse(payload)
      for (const choice of Array.isArray(value.choices) ? value.choices : []) {
        if (typeof choice.finish_reason === 'string' && !observation.finishReasons.includes(choice.finish_reason)) {
          observation.finishReasons.push(choice.finish_reason)
        }
        for (const call of Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : []) {
          const name = call.function?.name
          if (typeof name === 'string' && !observation.toolCallNames.includes(name)) observation.toolCallNames.push(name)
          const argumentsValue = call.function?.arguments
          if (typeof argumentsValue === 'string' && argumentsValue !== '') {
            observation.toolCallArgumentDigests.push(createHash('sha256').update(argumentsValue).digest('hex'))
          }
        }
      }
    } catch {
      observation.invalidFrames += 1
    }
  }
  return remainder
}

function summarizeRequest(body, profile) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const toolNames = tools.map((tool) => tool?.function?.name).filter((name) => typeof name === 'string')
  return {
    model: typeof body.model === 'string' ? body.model : null,
    stream: body.stream === true,
    profile,
    tokenlessExecutionMode: 'browser',
    messageCount: messages.length,
    messageRoles: messages.map((message) => message?.role).filter((role) => typeof role === 'string'),
    toolMessageCount: messages.filter((message) => message?.role === 'tool').length,
    assistantToolCallCount: messages.reduce((count, message) => count + (Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0), 0),
    toolNames,
    toolChoice: typeof body.tool_choice === 'string' ? body.tool_choice : body.tool_choice?.function?.name ?? null,
    hasResponseFormat: body.response_format !== undefined,
  }
}

function summarizeJsonResponse(status, contentType, bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { status, contentType, validJson: false }
  }
  const choices = Array.isArray(value.choices) ? value.choices : []
  const error = value.error && typeof value.error === 'object' && !Array.isArray(value.error)
    ? value.error
    : null
  const errorCode = typeof error?.code === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/u.test(error.code)
    ? error.code
    : null
  const toolCallNames = choices.flatMap((choice) => Array.isArray(choice.message?.tool_calls)
    ? choice.message.tool_calls.map((call) => call.function?.name).filter((name) => typeof name === 'string')
    : [])
  return {
    status,
    contentType,
    validJson: true,
    choiceCount: choices.length,
    errorCode,
    finishReasons: choices.map((choice) => choice.finish_reason).filter((reason) => typeof reason === 'string'),
    toolCallNames,
  }
}

async function readJsonObject(request) {
  const declared = request.headers['content-length']
  if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) throw new Error('request body is too large')
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(bytes)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request body must be a JSON object')
  return value
}

function authorized(header, expected) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const presented = Buffer.from(header.slice('Bearer '.length))
  const actual = Buffer.from(expected)
  return presented.length === actual.length && timingSafeEqual(presented, actual)
}

function writeError(response, status, code) {
  const body = JSON.stringify({ error: { code, message: code } })
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}
