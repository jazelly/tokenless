import { once } from 'node:events'
import fs from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import { readTokenlessConfig } from '../job-store.js'
import type { G4fServiceClient } from '../g4f/client.js'
import { g4fProviderName } from '../providers/direct/g4f-map.js'
import { ManagedProfileRegistry } from '../playwright/profiles/registry.js'
import type { JobStore } from './job-store.js'

const API_PREFIX = '/v1/direct/g4f'
const MAX_DIRECT_BODY_BYTES = 64 * 1024 * 1024
const DATA_PLANE_SUFFIXES = new Set([
  'chat/completions',
  'responses',
  'messages',
  'images/generations',
  'audio/transcriptions',
  'audio/speech',
])

export async function handleG4fApiRequest({
  store,
  client,
  request,
  response,
  method,
  url,
}: {
  store: JobStore
  client: G4fServiceClient | undefined
  request: IncomingMessage
  response: ServerResponse
  method: string
  url: URL
}) {
  if (!url.pathname.startsWith(`${API_PREFIX}/`) && url.pathname !== API_PREFIX) return false
  if (!client) {
    writeJson(response, 503, { error: { code: 'g4f_service_unavailable', message: 'The private G4F service is not running.' } })
    return true
  }

  if (method === 'GET' && url.pathname === `${API_PREFIX}/providers`) {
    const upstreamResponse = await client.rawRequest({ path: '/v1/providers' })
    if (!upstreamResponse.ok) {
      await forwardResponse(upstreamResponse, response, url)
      return true
    }
    const payload = await upstreamResponse.json() as unknown
    const providers = Array.isArray(payload) ? payload : []
    writeJson(response, 200, providers.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const record = item as Record<string, unknown>
      const upstreamProvider = typeof record.id === 'string' ? record.id : null
      return upstreamProvider ? { ...record, id: `g4f:${upstreamProvider}`, upstreamProvider } : record
    }))
    return true
  }

  if (method === 'GET' && url.pathname === `${API_PREFIX}/pa/providers`) {
    await proxyResponse(client, { path: '/pa/providers' }, response, url)
    return true
  }

  const paProvider = new RegExp(`^${API_PREFIX}/pa/providers/([^/]+)$`).exec(url.pathname)
  if (paProvider && method === 'GET') {
    await proxyResponse(client, { path: `/pa/providers/${encodeURIComponent(decodeURIComponent(paProvider[1] ?? ''))}` }, response, url)
    return true
  }

  if (method === 'GET' && url.pathname === `${API_PREFIX}/auth-contexts`) {
    await proxyResponse(client, { path: '/tokenless/auth-contexts' }, response, url)
    return true
  }

  const providerInfo = new RegExp(`^${API_PREFIX}/providers/([^/]+)(?:/(models|quota))?$`).exec(url.pathname)
  if (providerInfo && method === 'GET') {
    const provider = decodeURIComponent(providerInfo[1] ?? '')
    const upstream = resolveUpstreamProvider(provider)
    const action = providerInfo[2]
    const path = action === 'models'
      ? `/api/${encodeURIComponent(upstream)}/models`
      : action === 'quota'
        ? `/api/${encodeURIComponent(upstream)}/quota`
        : `/v1/providers/${encodeURIComponent(upstream)}`
    await proxyResponse(client, { path, authContextId: authContextHeader(request) }, response, url)
    return true
  }

  const authRoute = new RegExp(`^${API_PREFIX}/auth-contexts/([^/]+)(?:/(files))?$`).exec(url.pathname)
  if (authRoute) {
    const contextId = decodeURIComponent(authRoute[1] ?? '')
    if (method === 'POST' && !authRoute[2]) {
      const body = parseJson(await readBoundedBody(request))
      const provider = requiredText(body.provider, 'provider')
      const profileSlug = requiredText(body.profile, 'profile')
      const profile = await assertProfileProvider(store.homeDir, profileSlug, provider)
      await assertAuthSourceScope(body.source, profile.directory)
      const upstream = resolveUpstreamProvider(provider)
      const upstreamResponse = await client.rawRequest({
        path: `/tokenless/auth-contexts/${encodeURIComponent(contextId)}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, provider: upstream }),
      })
      await forwardResponse(upstreamResponse, response, url)
      return true
    }
    if (method === 'POST' && authRoute[2] === 'files') {
      const body = await readBoundedBody(request)
      const upstreamResponse = await client.rawRequest({
        path: `/tokenless/auth-contexts/${encodeURIComponent(contextId)}/files`,
        method: 'POST',
        headers: { 'content-type': requiredHeader(request, 'content-type') },
        body,
      })
      await forwardResponse(upstreamResponse, response, url)
      return true
    }
    if (method === 'DELETE' && !authRoute[2]) {
      await proxyResponse(client, {
        path: `/tokenless/auth-contexts/${encodeURIComponent(contextId)}`,
        method: 'DELETE',
      }, response, url)
      return true
    }
  }

  const assetRoute = new RegExp(`^${API_PREFIX}/assets/(images|media)/([^/]+)$`).exec(url.pathname)
  if (assetRoute && method === 'GET') {
    const kind = assetRoute[1]
    const filename = encodeURIComponent(decodeURIComponent(assetRoute[2] ?? ''))
    await proxyResponse(client, { path: `/${kind}/${filename}${url.search}` }, response, url)
    return true
  }

  const dataRoute = new RegExp(`^${API_PREFIX}/([^/]+)/(.+)$`).exec(url.pathname)
  if (dataRoute && (method === 'POST' || method === 'GET')) {
    const provider = decodeURIComponent(dataRoute[1] ?? '')
    const suffix = dataRoute[2] ?? ''
    if (!DATA_PLANE_SUFFIXES.has(suffix)) {
      writeJson(response, 404, { error: { code: 'g4f_route_not_found', message: 'Direct G4F route is not available.' } })
      return true
    }
    const upstream = resolveUpstreamProvider(provider)
    const contentType = headerValue(request, 'content-type')
    const rawBody = method === 'POST' ? await readBoundedBody(request) : undefined
    const body = rawBody && contentType?.includes('application/json')
      ? JSON.stringify({ ...parseJson(rawBody), provider: upstream })
      : rawBody
    await proxyResponse(client, {
      path: `/api/${encodeURIComponent(upstream)}/${suffix}${url.search}`,
      method,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(headerValue(request, 'accept') ? { accept: headerValue(request, 'accept')! } : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(authContextHeader(request) ? { authContextId: authContextHeader(request)! } : {}),
    }, response, url)
    return true
  }

  writeJson(response, 404, { error: { code: 'g4f_route_not_found', message: 'Direct G4F route is not available.' } })
  return true
}

async function assertProfileProvider(homeDir: string, profileSlug: string, provider: string) {
  const [profile, config] = await Promise.all([
    new ManagedProfileRegistry(homeDir).resolveProfile(profileSlug),
    readTokenlessConfig(homeDir),
  ])
  const explicitlyNamedG4fProvider = /^g4f:[A-Za-z0-9_]+$/.test(provider)
  if (
    profile.lifecycle !== 'ready' ||
    !config.g4f.enabled ||
    (!explicitlyNamedG4fProvider && !config.profiles[profile.slug]?.enabledProviders.includes(provider))
  ) {
    throw publicError(409, 'g4f_auth_scope_invalid', 'The selected profile does not enable this provider.')
  }
  return profile
}

async function assertAuthSourceScope(value: unknown, profileDirectory: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const source = value as Record<string, unknown>
  if (source.type !== 'browser-cookie3' && source.type !== 'cookie-database') return
  if (typeof source.path !== 'string' || !source.path) {
    throw publicError(400, 'g4f_cookie_path_required', 'Cookie database auth requires an exact selected-profile path.')
  }
  let database: string
  let profileRoot: string
  try {
    [database, profileRoot] = await Promise.all([fs.realpath(source.path), fs.realpath(profileDirectory)])
  } catch {
    throw publicError(400, 'g4f_cookie_path_invalid', 'Cookie database path is not a readable file in the selected profile.')
  }
  const relative = path.relative(profileRoot, database)
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw publicError(409, 'g4f_cookie_path_scope_invalid', 'Cookie database path is outside the selected profile.')
  }
}

function resolveUpstreamProvider(provider: string) {
  const upstream = g4fProviderName(provider)
  if (upstream) return upstream
  const exact = /^g4f:([A-Za-z0-9_]+)$/.exec(provider)?.[1]
  if (exact) return exact
  throw publicError(404, 'g4f_provider_unmapped', 'Use a mapped Tokenless provider id or an explicit g4f:<ProviderName> id.')
}

async function proxyResponse(
  client: G4fServiceClient,
  input: Parameters<G4fServiceClient['rawRequest']>[0],
  response: ServerResponse,
  requestUrl: URL,
) {
  await forwardResponse(await client.rawRequest(input), response, requestUrl)
}

async function forwardResponse(upstream: Response, response: ServerResponse, requestUrl: URL) {
  if (!upstream.ok) {
    writeJson(response, upstream.status, {
      error: { code: 'g4f_upstream_error', message: `The selected G4F provider returned HTTP ${upstream.status}.` },
    })
    return
  }
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
  if (contentType.includes('application/json')) {
    const payload = await upstream.json() as unknown
    writeJson(response, upstream.status, rewritePrivateAssetUrls(payload, requestUrl))
    return
  }
  response.statusCode = upstream.status
  response.setHeader('content-type', contentType)
  const cacheControl = upstream.headers.get('cache-control')
  if (cacheControl) response.setHeader('cache-control', cacheControl)
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!response.write(Buffer.from(chunk.value))) await once(response, 'drain')
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

function rewritePrivateAssetUrls(value: unknown, requestUrl: URL): unknown {
  if (Array.isArray(value)) return value.map((item) => rewritePrivateAssetUrls(item, requestUrl))
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value
    try {
      const candidate = new URL(value)
      if (candidate.hostname !== '127.0.0.1' && candidate.hostname !== 'localhost' && candidate.hostname !== '::1') return value
      const match = /^\/(images|media)\/([^/?#]+)$/.exec(candidate.pathname)
      return match ? `${requestUrl.origin}${API_PREFIX}/assets/${match[1]}/${match[2]}` : value
    } catch {
      return value
    }
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, rewritePrivateAssetUrls(item, requestUrl)]))
}

async function readBoundedBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > MAX_DIRECT_BODY_BYTES) throw publicError(413, 'g4f_request_too_large', 'Direct G4F request exceeds 64 MiB.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson(body: Buffer) {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw publicError(400, 'g4f_invalid_json', 'Direct G4F request body must be a JSON object.')
  }
}

function authContextHeader(request: IncomingMessage) {
  const value = headerValue(request, 'x-tokenless-auth-context')
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw publicError(400, 'g4f_auth_context_invalid', 'Direct G4F auth context id is invalid.')
  }
  return value
}

function requiredHeader(request: IncomingMessage, name: string) {
  const value = headerValue(request, name)
  if (!value) throw publicError(400, 'g4f_header_required', `${name} header is required.`)
  return value
}

function headerValue(request: IncomingMessage, name: string) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function requiredText(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw publicError(400, 'g4f_auth_context_invalid', `${field} is required.`)
  return value.trim()
}

function publicError(status: number, code: string, message: string) {
  const error = new Error(message) as Error & { status?: number; code?: string }
  error.status = status
  error.code = code
  return error
}

function writeJson(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}
