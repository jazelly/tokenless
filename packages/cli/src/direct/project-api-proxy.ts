import http from 'node:http'
import https from 'node:https'

import {
  MAX_CREDENTIAL_REJECTION_BYTES,
  isCredentialRejection,
  type CredentialCompatibility,
} from './credential-rejection.js'
import type { DirectProvider } from './types.js'

export type ProjectApiProxyRejection = Readonly<{
  status: number
  code: 'direct_request_too_large' | 'direct_timeout' | 'direct_upstream_error'
  message: string
}>

export type ProjectApiProxyOptions = Readonly<{
  request: http.IncomingMessage
  response: http.ServerResponse
  provider: DirectProvider
  compatibility: CredentialCompatibility
  upstream: URL
  requestHeaders: http.OutgoingHttpHeaders
  timeoutMs: number
  maxRequestBytes: number
  safeResponseHeaders: (headers: http.IncomingHttpHeaders) => http.OutgoingHttpHeaders
  reject: (rejection: ProjectApiProxyRejection) => void
  reportCredentialRejection: () => Promise<boolean>
  onUpstreamRequest?: ((request: http.ClientRequest, active: boolean) => void) | undefined
  onIncompleteRequest?: (() => void) | undefined
  shouldResumeRequest?: (() => boolean) | undefined
}>

/**
 * Performs exactly one upstream request and preserves response bytes. It never
 * retries. A bounded complete authentication response may update account health
 * for the next request, while the current response is returned unchanged.
 */
export function proxyProjectApiRequest(options: ProjectApiProxyOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const {
      request,
      response,
      upstream,
      requestHeaders,
      timeoutMs,
      maxRequestBytes,
    } = options
    let settled = false
    let timedOut = false
    let requestBytes = 0
    let upstreamResponseStarted = false
    let pausedForBackpressure = false
    let upstreamResponse: http.IncomingMessage | undefined

    const requestOptions: http.RequestOptions = {
      method: request.method,
      headers: requestHeaders,
      agent: false,
    }
    const upstreamRequest = upstream.protocol === 'https:'
      ? https.request(upstream, { ...requestOptions, rejectUnauthorized: true })
      : http.request(upstream, requestOptions)
    options.onUpstreamRequest?.(upstreamRequest, true)

    const timeoutTimer = setTimeout(() => {
      if (settled) return
      timedOut = true
      upstreamRequest.destroy(new Error('Tokenless project API upstream timeout.'))
      upstreamResponse?.destroy()
      if (!response.headersSent) {
        options.reject({
          status: 504,
          code: 'direct_timeout',
          message: 'The project API upstream timed out.',
        })
      } else if (!response.writableEnded) {
        response.destroy()
      }
      settle()
    }, timeoutMs)
    timeoutTimer.unref()

    const cleanup = () => {
      request.removeListener('data', onRequestData)
      request.removeListener('end', onRequestEnd)
      request.removeListener('error', abortUpstream)
      request.removeListener('aborted', abortUpstream)
      response.removeListener('close', onDownstreamClose)
      if (
        pausedForBackpressure &&
        !request.destroyed &&
        (options.shouldResumeRequest?.() ?? true)
      ) {
        request.resume()
      }
      pausedForBackpressure = false
    }
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      cleanup()
      options.onUpstreamRequest?.(upstreamRequest, false)
      resolve()
    }
    const finishResponse = () => {
      if (!response.writableEnded && !response.destroyed) response.end()
    }

    upstreamRequest.once('response', (incoming) => {
      upstreamResponseStarted = true
      upstreamResponse = incoming
      if (isRedirect(incoming.statusCode)) {
        incoming.destroy()
        upstreamRequest.destroy()
        options.reject({
          status: 502,
          code: 'direct_upstream_error',
          message: 'The project API upstream returned a disallowed redirect.',
        })
        settle()
        return
      }
      handleUpstreamResponse(
        options,
        incoming,
        finishResponse,
        () => clearTimeout(timeoutTimer),
        settle,
      )
    })
    upstreamRequest.once('upgrade', (incoming, socket) => {
      incoming.destroy()
      socket.destroy()
      if (settled) return
      options.reject({
        status: 502,
        code: 'direct_upstream_error',
        message: 'The project API upstream returned an unsupported protocol upgrade.',
      })
      settle()
    })
    upstreamRequest.once('error', () => {
      if (settled) return
      if (!upstreamResponseStarted && !response.headersSent) {
        options.reject({
          status: timedOut ? 504 : 502,
          code: timedOut ? 'direct_timeout' : 'direct_upstream_error',
          message: timedOut
            ? 'The project API upstream timed out.'
            : 'The project API upstream request failed.',
        })
      } else if (!response.writableEnded) {
        response.destroy()
      }
      settle()
    })
    upstreamRequest.once('close', () => options.onUpstreamRequest?.(upstreamRequest, false))

    const abortUpstream = () => {
      if (!upstreamRequest.destroyed) upstreamRequest.destroy()
      upstreamResponse?.destroy()
      settle()
    }
    const onDownstreamClose = () => {
      if (!response.writableEnded) abortUpstream()
    }
    const onRequestData = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      requestBytes += chunk.byteLength
      if (requestBytes > maxRequestBytes) {
        request.pause()
        pausedForBackpressure = false
        upstreamRequest.destroy()
        options.reject({
          status: 413,
          code: 'direct_request_too_large',
          message: 'The project API request exceeded the supported size limit.',
        })
        settle()
        return
      }
      if (settled || upstreamRequest.destroyed || upstreamRequest.writableEnded) return
      if (!upstreamRequest.write(chunk)) {
        request.pause()
        pausedForBackpressure = true
        upstreamRequest.once('drain', () => {
          pausedForBackpressure = false
          if (!request.destroyed && !settled) request.resume()
        })
      }
    }
    const onRequestEnd = () => {
      if (!settled && !upstreamRequest.destroyed) upstreamRequest.end()
    }

    request.on('data', onRequestData)
    request.once('end', onRequestEnd)
    request.once('error', abortUpstream)
    request.once('aborted', abortUpstream)
    response.once('close', onDownstreamClose)
  })
}

function handleUpstreamResponse(
  options: ProjectApiProxyOptions,
  upstreamResponse: http.IncomingMessage,
  finishResponse: () => void,
  stopUpstreamTimer: () => void,
  settle: () => void,
): void {
  const statusCode = upstreamResponse.statusCode ?? 502
  const responseHeaders = options.safeResponseHeaders(upstreamResponse.headers)
  if (!options.request.complete) {
    options.response.shouldKeepAlive = false
    responseHeaders.connection = 'close'
    options.onIncompleteRequest?.()
  }

  const candidate = (statusCode === 400 || statusCode === 401) &&
    !declaredBodyExceedsLimit(upstreamResponse.headers['content-length'])
  if (!candidate) {
    streamResponse(
      options.response,
      upstreamResponse,
      statusCode,
      responseHeaders,
      stopUpstreamTimer,
      settle,
    )
    return
  }

  const chunks: Buffer[] = []
  let total = 0
  let switchedToStreaming = false
  let ended = false

  const failIncomplete = () => {
    if (ended) return
    ended = true
    if (!options.response.headersSent) {
      options.reject({
        status: 502,
        code: 'direct_upstream_error',
        message: 'The project API upstream response ended unexpectedly.',
      })
    } else if (!options.response.writableEnded) {
      options.response.destroy()
    }
    settle()
  }

  upstreamResponse.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    if (switchedToStreaming) {
      writeStreamingChunk(options.response, upstreamResponse, chunk)
      return
    }
    chunks.push(chunk)
    total += chunk.byteLength
    if (total <= MAX_CREDENTIAL_REJECTION_BYTES) return
    switchedToStreaming = true
    writeResponseHead(options.response, statusCode, responseHeaders)
    for (const buffered of chunks) writeStreamingChunk(options.response, upstreamResponse, buffered)
    chunks.length = 0
  })
  upstreamResponse.once('aborted', failIncomplete)
  upstreamResponse.once('error', failIncomplete)
  upstreamResponse.once('end', () => {
    if (ended) return
    ended = true
    stopUpstreamTimer()
    if (switchedToStreaming) {
      finishResponse()
      return
    }
    const body = Buffer.concat(chunks, total)
    const contentType = singleHeaderValue(upstreamResponse.headers['content-type'])
    void completeCandidateResponse(options, statusCode, contentType, body)
      .finally(() => {
        if (!options.response.writableEnded && !options.response.destroyed) {
          writeResponseHead(options.response, statusCode, responseHeaders)
          options.response.end(body)
        }
      })
  })
  options.response.once('finish', settle)
  options.response.once('close', settle)
}

async function completeCandidateResponse(
  options: ProjectApiProxyOptions,
  statusCode: number,
  contentType: string | undefined,
  body: Buffer,
): Promise<void> {
  if (!isCredentialRejection({
    provider: options.provider,
    compatibility: options.compatibility,
    statusCode,
    contentType,
    body,
    complete: true,
  })) {
    return
  }
  await options.reportCredentialRejection().catch(() => false)
}

function streamResponse(
  response: http.ServerResponse,
  upstreamResponse: http.IncomingMessage,
  statusCode: number,
  headers: http.OutgoingHttpHeaders,
  stopUpstreamTimer: () => void,
  settle: () => void,
): void {
  writeResponseHead(response, statusCode, headers)
  upstreamResponse.on('data', (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    writeStreamingChunk(response, upstreamResponse, chunk)
  })
  upstreamResponse.once('aborted', () => {
    if (!response.writableEnded) response.destroy()
    settle()
  })
  upstreamResponse.once('error', () => {
    if (!response.writableEnded) response.destroy()
    settle()
  })
  upstreamResponse.once('end', () => {
    stopUpstreamTimer()
    if (!response.writableEnded && !response.destroyed) response.end()
  })
  response.once('finish', settle)
  response.once('close', settle)
}

function writeResponseHead(
  response: http.ServerResponse,
  statusCode: number,
  headers: http.OutgoingHttpHeaders,
): void {
  if (response.headersSent || response.destroyed) return
  response.writeHead(statusCode, headers)
  response.flushHeaders()
}

function writeStreamingChunk(
  response: http.ServerResponse,
  upstreamResponse: http.IncomingMessage,
  chunk: Buffer,
): void {
  if (response.destroyed || response.writableEnded) return
  if (!response.write(chunk)) {
    upstreamResponse.pause()
    response.once('drain', () => {
      if (!response.destroyed && !response.writableEnded) upstreamResponse.resume()
    })
  }
}

function declaredBodyExceedsLimit(value: string | string[] | undefined): boolean {
  if (Array.isArray(value) || value === undefined || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false
  const length = Number(value)
  return Number.isSafeInteger(length) && length > MAX_CREDENTIAL_REJECTION_BYTES
}

function singleHeaderValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode !== undefined && statusCode >= 300 && statusCode < 400
}
