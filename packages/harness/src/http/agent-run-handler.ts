import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createLocalHttpProviderTurnClient } from './provider-client.js'
import { createStdioMcpToolRegistry } from '../mcp/stdio.js'
import { openWebAgentHarness } from '../run/web-agent-harness.js'
import type { AgentRunSpec } from '../contracts.js'

type JsonRecord = Record<string, unknown>

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024

export type AgentRunHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
) => Promise<boolean>

export function createAgentRunHttpHandler({
  tokenlessHome,
  baseUrl,
  token,
}: {
  tokenlessHome: string
  baseUrl: string
  token: string
}): AgentRunHttpHandler {
  const activeRuns = new Map<string, Promise<void>>()

  return async (request, response, method, url) => {
    const route = /^\/v1\/private\/agent\/runs(?:\/([^/]+)(?:\/(resume|cancel))?)?$/.exec(url.pathname)
    const admissionRoute = /^\/v1\/private\/agent\/admissions\/([^/]+)$/.exec(url.pathname)
    if (!route && !admissionRoute) return false

    const harness = await openWebAgentHarness({
      tokenlessHome,
      providerClient: createLocalHttpProviderTurnClient({ baseUrl, token }),
      toolRegistry: createStdioMcpToolRegistry(),
    })
    const driveRun = async <T>(runId: string, operation: () => Promise<T>) => {
      const previous = activeRuns.get(runId) ?? Promise.resolve()
      const result = previous.then(operation, operation)
      const active = result.then(() => undefined, () => undefined)
      activeRuns.set(runId, active)
      try {
        return await result
      } finally {
        if (activeRuns.get(runId) === active) activeRuns.delete(runId)
      }
    }

    try {
      if (method === 'GET' && admissionRoute) {
        const admissionRef = decodeURIComponent(admissionRoute[1] ?? '')
        const view = await harness.readAdmission(admissionRef)
        if (!view) {
          writeJson(response, 404, { error: { code: 'harness_admission_missing', message: 'Harness admission was not found.', retryable: false } })
          return true
        }
        writeJson(response, 200, view)
        return true
      }
      if (!route) return false
      const encodedRunId = route[1]
      const runId = encodedRunId ? decodeURIComponent(encodedRunId) : undefined
      const action = route[2]
      if (method === 'POST' && runId === undefined) {
        const body = await readJsonObject(request)
        const allowed = new Set(['admissionRef', 'provider', 'profileId', 'taskPrompt', 'selectedSkills', 'finalOutput', 'limits', 'maxTurns', 'mcpServers'])
        if (Object.keys(body).some((key) => !allowed.has(key))) throw requestError('invalid_input', 'Harness run request contains an unknown field')
        writeJson(response, 200, await harness.start({
          ...body,
          stagingRoot: path.join(tokenlessHome, 'harness-staging'),
        } as AgentRunSpec))
        return true
      }
      if (!runId) return false
      if (method === 'GET' && action === undefined) {
        const view = await driveRun(runId, () => harness.read(runId))
        if (!view) throw requestError('invalid_input', 'Harness run was not found')
        writeJson(response, 200, view)
        return true
      }
      if (method === 'POST' && action === 'resume') {
        const intervention = await readJsonObject(request)
        writeJson(response, 200, await driveRun(runId, () => harness.resume(runId, intervention)))
        return true
      }
      if (method === 'POST' && action === 'cancel') {
        const body = await readJsonObject(request)
        if (Object.keys(body).length > 0) throw requestError('invalid_input', 'Harness cancel body must be empty')
        writeJson(response, 200, await driveRun(runId, () => harness.cancel(runId)))
        return true
      }
      return false
    } catch (error) {
      const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : ''
      const status = code === 'harness_run_missing'
        ? 404
        : code === 'harness_run_conflict' || code === 'harness_admission_conflict'
          ? 409
          : code.startsWith('harness_')
            ? 400
            : 500
      writeJson(response, status, {
        error: {
          code: code || 'harness_internal_error',
          message: status === 500 ? 'Harness operation failed.' : error instanceof Error ? error.message : 'Harness operation failed.',
          retryable: status >= 500 || code === 'harness_run_conflict',
        },
      })
      return true
    } finally {
      harness.close()
    }
  }
}

async function readJsonObject(request: IncomingMessage): Promise<JsonRecord> {
  const contentLength = request.headers['content-length']
  const declaredLength = Array.isArray(contentLength) ? contentLength[0] : contentLength
  if (declaredLength !== undefined && declaredLength !== '' && Number(declaredLength) > MAX_HTTP_BODY_BYTES) {
    throw requestError('invalid_input', 'request body must be valid JSON: Failed to buffer the request body')
  }
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.length
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      throw requestError('invalid_input', 'request body must be valid JSON: Failed to buffer the request body')
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) throw requestError('invalid_input', 'request body must be valid JSON: missing request body')
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
    return parsed as JsonRecord
  } catch (error) {
    throw requestError('invalid_input', `request body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function requestError(code: string, message: string) {
  return Object.assign(new Error(message), { code })
}
