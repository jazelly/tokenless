export const RELAY_PROTOCOL_VERSION = 'tokenless.relay.v1'

export function createRelayRun(input = {}) {
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

export function validateRelayRun(payload) {
  if (!payload || typeof payload !== 'object') {
    return invalid('invalid_run', 'Relay run must be an object.')
  }
  if (payload.protocol !== RELAY_PROTOCOL_VERSION) {
    return invalid('unsupported_protocol', 'Relay protocol version is not supported.')
  }
  if (typeof payload.requestId !== 'string' || payload.requestId.trim() === '') {
    return invalid('invalid_request_id', 'Run requestId must be a nonempty string.')
  }
  if (typeof payload.provider !== 'string' || payload.provider.trim() === '') {
    return invalid('invalid_provider', 'Run provider must be a nonempty string.')
  }
  if (typeof payload.action !== 'string' || payload.action.trim() === '') {
    return invalid('invalid_action', 'Run action must be a nonempty string.')
  }
  if ((payload.action === 'submit' || payload.action === 'submit_and_read') && typeof payload.prompt !== 'string') {
    return invalid('invalid_prompt', 'Submit actions require a prompt string.')
  }
  return { ok: true, run: { ...payload } }
}

export function createRelayResult(run, result) {
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

function invalid(code, message) {
  return { ok: false, error: { code, message, retryable: false } }
}

function normalizeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'relay_error',
    message: typeof error?.message === 'string' ? error.message : 'Relay failed.',
    retryable: Boolean(error?.retryable),
  }
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
