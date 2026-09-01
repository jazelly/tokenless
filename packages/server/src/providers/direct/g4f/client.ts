import fs from 'node:fs/promises'
import path from 'node:path'

import {
  G4F_SERVICE_PROTOCOL,
  G4F_SERVICE_REVISION,
  G4F_UPSTREAM_COMMIT,
  G4F_VERSION,
} from './constants.js'
import type {
  G4fAuthContextInput,
  G4fProxyRequest,
  G4fServiceHealth,
} from './types.js'
import { readG4fUpstreamDiagnostic, type G4fUpstreamDiagnostic } from './upstream-error.js'

export class G4fServiceClient {
  constructor(
    readonly origin: string,
    private readonly serviceKey: string,
  ) {}

  async health(signal?: AbortSignal): Promise<G4fServiceHealth> {
    const response = await this.request({ path: '/tokenless/health', signal })
    const payload = await response.json() as unknown
    if (!isHealth(payload)) throw new Error('Tokenless G4F service returned an invalid health contract.')
    return payload
  }

  async createAuthContext(input: G4fAuthContextInput, signal?: AbortSignal) {
    const response = await this.request({
      path: `/tokenless/auth-contexts/${encodeURIComponent(input.contextId)}`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: input.provider,
        profile: input.profile,
        lifetime: input.lifetime,
        source: input.source,
      }),
      signal,
    })
    return await response.json() as Record<string, unknown>
  }

  async uploadAuthFiles(contextId: string, files: readonly string[], signal?: AbortSignal) {
    const form = new FormData()
    for (const file of files) {
      const data = await fs.readFile(file)
      form.append('files', new Blob([data]), path.basename(file))
    }
    const response = await this.request({
      path: `/tokenless/auth-contexts/${encodeURIComponent(contextId)}/files`,
      method: 'POST',
      body: form,
      signal,
    })
    return await response.json() as Record<string, unknown>
  }

  async deleteAuthContext(contextId: string, signal?: AbortSignal) {
    await this.request({
      path: `/tokenless/auth-contexts/${encodeURIComponent(contextId)}`,
      method: 'DELETE',
      signal,
    })
  }

  async request(input: G4fProxyRequest) {
    const response = await this.rawRequest(input)
    if (!response.ok) {
      throw g4fServiceError(await readG4fUpstreamDiagnostic(response))
    }
    return response
  }

  async rawRequest(input: G4fProxyRequest) {
    if (!input.path.startsWith('/') || input.path.startsWith('//')) {
      throw new Error('G4F service request path must be absolute and local.')
    }
    const headers = new Headers(input.headers)
    headers.set('x-tokenless-service-key', this.serviceKey)
    headers.set('g4f-api-key', this.serviceKey)
    if (input.authContextId) headers.set('x-tokenless-auth-context', input.authContextId)
    const response = await fetch(new URL(input.path, this.origin), {
      method: input.method ?? 'GET',
      headers,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      redirect: 'manual',
    })
    return response
  }
}

function isHealth(value: unknown): value is G4fServiceHealth {
  if (!value || typeof value !== 'object') return false
  const health = value as Record<string, unknown>
  return health.protocol === G4F_SERVICE_PROTOCOL &&
    health.status === 'ready' &&
    health.g4fVersion === G4F_VERSION &&
    health.pinnedG4fVersion === G4F_VERSION &&
    health.pinnedG4fCommit === G4F_UPSTREAM_COMMIT &&
    health.workerCount === 1 &&
    health.paAutoDownload === false &&
    health.requestLogging === false
    && health.browserMode === 'headless'
    && health.browserAutoDiscovery === false
    && health.serviceRevision === G4F_SERVICE_REVISION
}

function g4fServiceError(diagnostic: G4fUpstreamDiagnostic) {
  const error = new Error(diagnostic.message) as Error & {
    code?: string
    status?: number
    g4f?: G4fUpstreamDiagnostic['upstream']
  }
  error.code = diagnostic.code
  error.status = diagnostic.status
  error.g4f = diagnostic.upstream
  return error
}
