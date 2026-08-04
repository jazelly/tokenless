const TOKENLESS_LATEST_URL = 'https://registry.npmjs.org/tokenless/latest'
const DEFAULT_NPM_REGISTRY_TIMEOUT_MS = 2_500
const MAX_NPM_REGISTRY_RESPONSE_BYTES = 64 * 1024
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type TokenlessLatestVersionResult =
  | {
      ok: true
      packageName: 'tokenless'
      registryUrl: string
      latestVersion: string
    }
  | {
      ok: false
      packageName: 'tokenless'
      registryUrl: string
      code: string
      message: string
    }

export async function fetchTokenlessLatestVersion({
  timeoutMs = DEFAULT_NPM_REGISTRY_TIMEOUT_MS,
}: {
  timeoutMs?: number | undefined
} = {}): Promise<TokenlessLatestVersionResult> {
  const registryUrl = TOKENLESS_LATEST_URL
  try {
    const response = await fetch(registryUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'tokenless-cli',
      },
      signal: AbortSignal.timeout(normalizeTimeoutMs(timeoutMs)),
    })
    if (!response.ok) {
      return {
        ok: false,
        packageName: 'tokenless',
        registryUrl,
        code: 'npm_registry_http_error',
        message: `npm registry returned HTTP ${response.status} for tokenless/latest.`,
      }
    }
    let body: unknown
    try {
      body = JSON.parse(await readResponseText(response, MAX_NPM_REGISTRY_RESPONSE_BYTES)) as unknown
    } catch (error) {
      return {
        ok: false,
        packageName: 'tokenless',
        registryUrl,
        code: 'npm_registry_invalid_response',
        message: error instanceof Error ? error.message : 'npm registry returned invalid JSON.',
      }
    }
    if (!isRecord(body) || body.name !== 'tokenless' || typeof body.version !== 'string' || !SEMANTIC_VERSION_PATTERN.test(body.version)) {
      return {
        ok: false,
        packageName: 'tokenless',
        registryUrl,
        code: 'npm_registry_invalid_response',
        message: 'npm registry returned an invalid tokenless/latest response.',
      }
    }
    return {
      ok: true,
      packageName: 'tokenless',
      registryUrl,
      latestVersion: body.version,
    }
  } catch (error) {
    return {
      ok: false,
      packageName: 'tokenless',
      registryUrl,
      code: error instanceof DOMException && error.name === 'TimeoutError'
        ? 'npm_registry_timeout'
        : 'npm_registry_unavailable',
      message: error instanceof Error ? error.message : 'npm registry is unavailable.',
    }
  }
}

async function readResponseText(response: Response, maxBytes: number) {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error(`npm registry response exceeded ${maxBytes} bytes.`)
  }
  const reader = response.body?.getReader()
  if (!reader) return await response.text()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) throw new Error(`npm registry response exceeded ${maxBytes} bytes.`)
    chunks.push(value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function normalizeTimeoutMs(value: number) {
  return Number.isFinite(value) && value > 0 && value <= 2_147_483_647
    ? Math.floor(value)
    : DEFAULT_NPM_REGISTRY_TIMEOUT_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
