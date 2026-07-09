export const RELAY_PROTOCOL_VERSION = 'tokenless.relay.v1'

export type RelayRunInput = {
  requestId?: string
  provider?: string
  action?: string
  prompt?: string
  targetUrl?: string
  context?: unknown
  metadata?: unknown
}

export type RelayRun = Required<Pick<RelayRunInput, 'requestId' | 'provider' | 'action'>> & {
  protocol: typeof RELAY_PROTOCOL_VERSION
  prompt?: string | undefined
  targetUrl?: string | undefined
  context?: unknown
  metadata?: unknown
}

type RelayError = {
  code: string
  message: string
  retryable: boolean
}

export type RelayRunValidation =
  | { ok: true; run: RelayRun }
  | { ok: false; error: RelayError }

type RelayExecutionResult =
  | { ok: true; result?: unknown }
  | { ok: false; error?: Partial<RelayError> }

export function createRelayRun(input: RelayRunInput = {}): RelayRun {
  const requestId = input.requestId ?? randomId()
  return {
    protocol: RELAY_PROTOCOL_VERSION,
    requestId,
    provider: input.provider ?? 'chatgpt',
    action: input.action ?? 'submit_and_read',
    prompt: input.prompt,
    targetUrl: input.targetUrl,
    context: input.context,
    metadata: input.metadata,
  }
}

export function validateRelayRun(payload: unknown): RelayRunValidation {
  if (!payload || typeof payload !== 'object') {
    return invalid('invalid_run', 'Relay run must be an object.')
  }
  const run = payload as Record<string, unknown>
  if (run.protocol !== RELAY_PROTOCOL_VERSION) {
    return invalid('unsupported_protocol', 'Relay protocol version is not supported.')
  }
  if (typeof run.requestId !== 'string' || run.requestId.trim() === '') {
    return invalid('invalid_request_id', 'Run requestId must be a nonempty string.')
  }
  if (typeof run.provider !== 'string' || run.provider.trim() === '') {
    return invalid('invalid_provider', 'Run provider must be a nonempty string.')
  }
  if (typeof run.action !== 'string' || run.action.trim() === '') {
    return invalid('invalid_action', 'Run action must be a nonempty string.')
  }
  if ((run.action === 'submit' || run.action === 'submit_and_read') && typeof run.prompt !== 'string') {
    return invalid('invalid_prompt', 'Submit actions require a prompt string.')
  }
  return { ok: true, run: { ...(run as RelayRun) } }
}

export function createRelayResult(run: Partial<RelayRun> | null | undefined, result: RelayExecutionResult) {
  return {
    protocol: RELAY_PROTOCOL_VERSION,
    requestId: run?.requestId ?? null,
    ok: Boolean(result?.ok),
    provider: run?.provider ?? null,
    action: run?.action ?? null,
    result: result?.ok ? result.result ?? null : null,
    error: result?.ok ? null : normalizeError(result?.error),
  }
}

function invalid(code: string, message: string): RelayRunValidation {
  return { ok: false, error: { code, message, retryable: false } }
}

function normalizeError(error: Partial<RelayError> | null | undefined): RelayError {
  return {
    code: typeof error?.code === 'string' ? error.code : 'relay_error',
    message: typeof error?.message === 'string' ? error.message : 'Relay failed.',
    retryable: Boolean(error?.retryable),
  }
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
