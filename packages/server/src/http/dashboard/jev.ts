import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  type Questions,
  type SystemOneResult,
} from '@typesafe-ai/sdk'
import type { HarnessFrontDoorProviderCandidate, HarnessFrontDoorRoute } from 'tokenless-internal-shared/harness-sidecar'
import {
  buildJevRouteQuestions,
  JEV_MODEL,
  JevRouteError,
  readJevRoute,
  type JevRouteAnswers,
} from '#tokenless-shared/jev-router.js'
import { readTokenlessConfig } from '../../persistence/config.js'

const JEV_HISTORY_LIMIT = 50

export type JevHistoryEntry = {
  id: string
  kind: 'route' | 'systemone'
  at: string
  latencyMs: number
  model: string
  request: unknown
  response: unknown
  error: string | null
}

const history: JevHistoryEntry[] = []

/**
 * Resolves the API key fresh on every call: the user's own key, configured in the
 * dashboard and persisted to config.json, takes precedence over the server process's
 * own TYPESAFE_API_KEY env var (which stays as a fallback for server operators). Reading
 * the small config file per call keeps a key change in the dashboard effective immediately,
 * with no daemon restart and no stale-client cache to invalidate.
 */
async function resolveJevApiKey(): Promise<string> {
  const config = await readTokenlessConfig()
  const configuredKey = config.router.jevApiKey?.trim()
  if (configuredKey) return configuredKey
  const envKey = process.env.TYPESAFE_API_KEY?.trim()
  if (envKey) return envKey
  throw jevError(
    'jev_api_key_missing',
    'No TypeSafe API key is configured. Add one in the dashboard\'s Router settings, or set TYPESAFE_API_KEY on the Tokenless server.',
    500,
  )
}

async function jevClient(): Promise<TypeSafeClient> {
  return new TypeSafeClient({ apiKey: await resolveJevApiKey() })
}

export function jevError(code: string, message: string, status: number): Error & { code: string, status: number } {
  return Object.assign(new Error(message), { code, status })
}

/** Map SDK/local errors to the {code, status, message} shape the dashboard HTTP layer expects. */
function toDashboardError(error: unknown): Error & { code: string, status: number } {
  if (error instanceof JevRouteError) return jevError(error.code, error.message, 502)
  if (error instanceof APIError) {
    const code = error instanceof AuthenticationError
      ? 'jev_authentication_failed'
      : error instanceof RateLimitError
        ? 'jev_rate_limited'
        : 'jev_request_rejected'
    return jevError(code, error.message, error.status)
  }
  if (error instanceof APIConnectionError) return jevError('jev_upstream_unavailable', error.message, 502)
  if (error instanceof TypeSafeError) return jevError('jev_client_error', error.message, 400)
  if (error && typeof error === 'object' && 'code' in error && 'status' in error) {
    return error as Error & { code: string, status: number }
  }
  return jevError('jev_request_failed', error instanceof Error ? error.message : String(error), 502)
}

function recordHistory(entry: JevHistoryEntry) {
  history.unshift(entry)
  history.length = Math.min(history.length, JEV_HISTORY_LIMIT)
}

export function listJevHistory(): JevHistoryEntry[] {
  return history.map((entry) => ({ ...entry }))
}

/** Run the batched Choice/Choice/Score request used to pick a provider for the router engine. */
export async function runJevRoute(
  task: string,
  providers: readonly HarnessFrontDoorProviderCandidate[],
): Promise<{ route: HarnessFrontDoorRoute, latencyMs: number }> {
  if (providers.length === 0) throw jevError('jev_route_candidates_missing', 'Jev routing requires at least one provider candidate.', 400)
  const questions = buildJevRouteQuestions(task, providers)
  const started = Date.now()
  let result: SystemOneResult<typeof questions>
  let route: HarnessFrontDoorRoute
  try {
    result = await (await jevClient()).systemOne({ state: { task }, model: JEV_MODEL, questions })
    route = readJevRoute(result.answers as JevRouteAnswers, providers)
  } catch (error) {
    const latencyMs = Date.now() - started
    const mapped = toDashboardError(error)
    recordHistory({
      id: crypto.randomUUID(),
      kind: 'route',
      at: new Date().toISOString(),
      latencyMs,
      model: JEV_MODEL,
      request: { task, questions },
      response: null,
      error: mapped.message,
    })
    throw mapped
  }
  const latencyMs = Date.now() - started
  recordHistory({
    id: crypto.randomUUID(),
    kind: 'route',
    at: new Date().toISOString(),
    latencyMs,
    model: result.model,
    request: { task, questions },
    response: result,
    error: null,
  })
  return { route, latencyMs }
}

export type JevSystemOnePayload = {
  state: unknown
  questions: Record<string, unknown>
  model?: string
}

/** Ad-hoc raw passthrough for the dashboard's Jev playground: send arbitrary state + questions. */
export async function runJevSystemOne(payload: JevSystemOnePayload): Promise<{
  model: string
  answers: unknown
  usage: unknown
  latencyMs: number
}> {
  const questions = validateJevQuestions(payload.questions)
  requireJevState(payload.state)
  const started = Date.now()
  let result: SystemOneResult<Questions>
  try {
    result = await (await jevClient()).systemOne({
      state: payload.state as never,
      questions,
      ...(payload.model ? { model: payload.model } : {}),
    })
  } catch (error) {
    const latencyMs = Date.now() - started
    const mapped = toDashboardError(error)
    recordHistory({
      id: crypto.randomUUID(),
      kind: 'systemone',
      at: new Date().toISOString(),
      latencyMs,
      model: payload.model ?? JEV_MODEL,
      request: payload,
      response: null,
      error: mapped.message,
    })
    throw mapped
  }
  const latencyMs = Date.now() - started
  recordHistory({
    id: crypto.randomUUID(),
    kind: 'systemone',
    at: new Date().toISOString(),
    latencyMs,
    model: result.model,
    request: payload,
    response: result,
    error: null,
  })
  return { model: result.model, answers: result.answers, usage: result.usage, latencyMs }
}

/**
 * TypeSafe's HTTP API requires a non-null `state`, even though the SDK's own TypeScript
 * types permit null there. Reject it locally with a clear message instead of round-tripping
 * to the API for a 422.
 */
function requireJevState(value: unknown): void {
  if (value === null || value === undefined || value === '') {
    throw jevError('jev_state_missing', 'Jev request must include non-empty "state" to evaluate.', 400)
  }
}

function validateJevQuestions(value: unknown): Questions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw jevError('jev_questions_invalid', 'Jev request must include at least one question.', 400)
  }
  for (const [name, question] of Object.entries(value as Record<string, unknown>)) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw jevError('jev_questions_invalid', `Question "${name}" must be an object.`, 400)
    }
    const type = (question as { type?: unknown }).type
    if (type !== 'noul' && type !== 'choice' && type !== 'score') {
      throw jevError('jev_questions_invalid', `Question "${name}" must have type "noul", "choice", or "score".`, 400)
    }
  }
  return value as Questions
}
