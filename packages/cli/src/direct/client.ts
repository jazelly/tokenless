import { executeChatGptApi } from './api-client.js'
import { runOfficialCodex } from './official-client.js'
import { DirectError } from './types.js'
import type { DirectBackend, DirectProvider, DirectRunRequest, DirectRunResult } from './types.js'

export type ExecuteDirectRunOptions = {
  /** A public API or compatible-gateway base URL. Credentials remain environment-only. */
  baseUrl?: string | undefined
  /** Includes all provider-client preflight and inference work. */
  timeoutMs?: number | undefined
  /** Testable/process-local override for TOKENLESS_CODEX_BIN. */
  codexExecutable?: string | undefined
}

/**
 * Select a direct backend without introducing a transport fallback.
 *
 * ChatGPT defaults to the provider-owned Codex client. Other providers will
 * default to their documented API adapters as those adapters are admitted.
 */
export function resolveDirectBackend(
  provider: DirectProvider,
  requestedBackend?: DirectBackend | undefined,
): DirectBackend {
  if (requestedBackend !== undefined && requestedBackend !== 'official-client' && requestedBackend !== 'api') {
    throw new DirectError(
      'direct_configuration_error',
      'The direct backend must be official-client or api.',
    )
  }
  return requestedBackend ?? (provider === 'chatgpt' ? 'official-client' : 'api')
}

/** Execute one isolated direct request. This function never falls back to visible mode. */
export async function executeDirectRun(
  request: DirectRunRequest,
  options: ExecuteDirectRunOptions = {},
): Promise<DirectRunResult> {
  if (request === null || typeof request !== 'object') {
    throw new DirectError('direct_configuration_error', 'A direct run request is required.')
  }
  if (request.provider !== 'chatgpt') {
    throw new DirectError(
      'direct_unsupported_provider',
      'This release supports direct execution only for the chatgpt provider.',
    )
  }

  const backend = resolveDirectBackend(request.provider, request.backend)
  if (backend === 'official-client') {
    if (options.baseUrl !== undefined) {
      throw new DirectError(
        'direct_configuration_error',
        'A direct base URL is available only with backend api.',
      )
    }
    return runOfficialCodex(
      { ...request, backend },
      {
        ...(options.codexExecutable === undefined ? {} : { executable: options.codexExecutable }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      },
    )
  }

  if (options.codexExecutable !== undefined) {
    throw new DirectError(
      'direct_configuration_error',
      'A Codex executable override is available only with backend official-client.',
    )
  }
  return executeChatGptApi(
    { ...request, backend },
    {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  )
}
