export type G4fUpstreamDiagnostic = {
  status: number
  code: string
  message: string
  provider: string | null
  upstream: {
    system: 'g4f'
    status: number
    type: string
    category: string
    provider: string | null
    model: string | null
  }
}

export async function readG4fUpstreamDiagnostic(
  response: Response,
  requestedProvider: string | null = null,
): Promise<G4fUpstreamDiagnostic> {
  const payload = await response.json().catch(() => null) as unknown
  const record = plainRecord(payload)
  const error = plainRecord(record?.error)
  const upstreamMessage = typeof error?.message === 'string' ? error.message : ''
  const validationType = Array.isArray(record?.detail)
    ? plainRecord(record.detail[0])?.type
    : null
  const type = errorType(upstreamMessage, validationType)
  const upstreamProvider = safeText(record?.provider)
  const model = safeText(record?.model)
  const provider = requestedProvider ?? upstreamProvider
  const category = errorCategory(type, response.status)
  return {
    status: response.status,
    code: `g4f_upstream_${snakeCase(type)}`,
    message: `G4F provider '${provider ?? 'unknown'}' failed with ${type} (upstream HTTP ${response.status}).`,
    provider,
    upstream: {
      system: 'g4f',
      status: response.status,
      type,
      category,
      provider: upstreamProvider,
      model,
    },
  }
}

function errorType(message: string, validationType: unknown) {
  const exception = /^([A-Za-z][A-Za-z0-9_.]{0,127}):(?:\s|$)/.exec(message)?.[1]
  if (exception) return exception
  if (typeof validationType === 'string' && validationType) return 'RequestValidationError'
  return 'HttpError'
}

function errorCategory(type: string, status: number) {
  const normalized = type.toLowerCase()
  if (normalized.includes('auth') || status === 401 || status === 403) return 'authentication'
  if (normalized.includes('rate') || status === 429) return 'rate_limit'
  if (normalized.includes('cloudflare') || normalized.includes('captcha')) return 'anti_bot'
  if (normalized.includes('model') && normalized.includes('not')) return 'model'
  if (normalized.includes('timeout')) return 'timeout'
  if (normalized.includes('curl') || normalized.includes('connection') || normalized.includes('proxy')) return 'transport'
  if (normalized.includes('validation') || status === 400 || status === 422) return 'invalid_request'
  return 'provider'
}

function snakeCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'http_error'
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeText(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)
    ? value
    : null
}
