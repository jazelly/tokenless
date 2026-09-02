export const HARNESS_SIDECAR_PROTOCOL = 'tokenless.harness-sidecar/v1' as const
export const SPARK_X25_4B_MLX_ENGINE_ID = 'spark-x2.5-4b-mlx' as const
export const SPARK_X25_4B_MLX_ENDPOINT = 'http://127.0.0.1:8080/v1/chat/completions' as const
export const SPARK_X25_4B_MLX_HEALTH_ENDPOINT = 'http://127.0.0.1:8080/health' as const
export const SPARK_X25_4B_MLX_MODEL = 'XHToken/Spark-X2.5-4B' as const
export const SPARK_X25_4B_MLX_TOOL_NAME = 'return_result' as const
const SPARK_COMPLETION_TIMEOUT_MS = 120_000
const ROUTER_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u

export type HarnessSidecarJsonPrimitive = string | number | boolean | null
export type HarnessSidecarJsonValue =
  | HarnessSidecarJsonPrimitive
  | HarnessSidecarJsonValue[]
  | { [key: string]: HarnessSidecarJsonValue }

export type HarnessSidecarBrowserBinding = {
  browserId: string
  family: string
  version: string | null
}

export type HarnessAiCompletionInput = {
  instruction: string
  input: HarnessSidecarJsonValue
  responseSchema: HarnessSidecarJsonValue
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

/** One browser, local, or remote implementation used by Harness sidecars. */
export type HarnessAiEngine = {
  id: string
  complete(input: HarnessAiCompletionInput): Promise<HarnessSidecarJsonValue>
}

export type HarnessFrontDoorProviderCandidate = {
  providerId: string
  label: string
  suitableTasks: string
  model: string | null
  plan: {
    accessClass: string
    planId: string
    label: string | null
  }
  capacity: {
    decision: 'admit' | 'unknown'
    rules: Array<{
      action: string
      publishedAllowance: number | null
      remainingUnits: number | null
      requestedUnits: number
      decision: 'admit' | 'unknown'
    }>
  }
}

export type HarnessFrontDoorInput = {
  taskPrompt: string
  providers: readonly HarnessFrontDoorProviderCandidate[]
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

export type HarnessFrontDoorRoute = {
  providerId: string
  model: string | null
  taskType: string
  complexity: 'low' | 'medium' | 'high'
  reason: string
}

export type HarnessFrontDoorResult = {
  protocol: typeof HARNESS_SIDECAR_PROTOCOL
  kind: 'front_door'
  engine: string
  title: string
  route: HarnessFrontDoorRoute
}

export type HarnessFrontDoorSidecar = {
  prepare(input: HarnessFrontDoorInput): Promise<HarnessFrontDoorResult>
}

export type HarnessExitDoorInput = {
  taskPrompt: string
  output: string
  artifacts: readonly string[]
  browserBinding?: HarnessSidecarBrowserBinding | undefined
}

export type HarnessExitDoorResult = {
  protocol: typeof HARNESS_SIDECAR_PROTOCOL
  kind: 'exit_door'
  engine: string
  summary: string
  labels: readonly string[]
}

export type HarnessExitDoorSidecar = {
  finalize(input: HarnessExitDoorInput): Promise<HarnessExitDoorResult>
}

export class HarnessSidecarError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'HarnessSidecarError'
    this.code = code
  }
}

/**
 * Browser- and Node-compatible adapter for the fixed local Spark MLX server.
 * The server is intentionally not configurable in V1: the Dashboard and the
 * real integration test must exercise the same local endpoint and model.
 */
export function createSparkX25MlxAiEngine(): HarnessAiEngine {
  return {
    id: SPARK_X25_4B_MLX_ENGINE_ID,
    async complete(input) {
      let response: Response
      try {
        response = await fetch(SPARK_X25_4B_MLX_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(SPARK_COMPLETION_TIMEOUT_MS),
          body: JSON.stringify({
            model: SPARK_X25_4B_MLX_MODEL,
            messages: [
              {
                role: 'system',
                content: [
                  input.instruction,
                  `Use the available ${SPARK_X25_4B_MLX_TOOL_NAME} tool exactly once. Do not answer with plain text or JSON content. Emit the native Spark tool call syntax beginning with <tool_call>${SPARK_X25_4B_MLX_TOOL_NAME}.`,
                ].join('\n'),
              },
              { role: 'user', content: JSON.stringify(input.input) },
            ],
            tools: [{
              type: 'function',
              function: {
                name: SPARK_X25_4B_MLX_TOOL_NAME,
                description: 'Return the requested structured result.',
                parameters: input.responseSchema,
              },
            }],
            tool_choice: {
              type: 'function',
              function: { name: SPARK_X25_4B_MLX_TOOL_NAME },
            },
            parallel_tool_calls: false,
            stream: false,
            temperature: 0,
            max_tokens: 512,
            chat_template_kwargs: { enable_thinking: false },
          }),
        })
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        throw new HarnessSidecarError(
          'harness_spark_request_failed',
          timedOut
            ? `Spark MLX request timed out after ${SPARK_COMPLETION_TIMEOUT_MS / 1_000} seconds.`
            : `Spark MLX request failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!response.ok) {
        throw new HarnessSidecarError(
          'harness_spark_request_failed',
          `Spark MLX request failed with HTTP ${response.status}.`,
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new HarnessSidecarError(
          'harness_spark_response_invalid',
          `Spark MLX response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return readSparkToolArguments(payload)
    },
  }
}

export function createHarnessFrontDoorSidecar(engine: HarnessAiEngine): HarnessFrontDoorSidecar {
  return {
    async prepare(input) {
      if (!input.taskPrompt.trim()) throw new HarnessSidecarError('harness_front_door_input_invalid', 'Front Door taskPrompt must not be empty.')
      if (input.providers.length === 0) throw new HarnessSidecarError('harness_front_door_candidates_missing', 'Front Door requires at least one provider candidate.')

      const title = readTitle(await engine.complete({
        instruction: 'Write a direct, descriptive title for this conversation. Use the conversation language. Return only JSON. Keep the title under eight words in English or twenty characters in Chinese.',
        input: { conversation: input.taskPrompt.slice(0, 4_000) },
        responseSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
          additionalProperties: false,
        },
        ...(input.browserBinding === undefined ? {} : { browserBinding: input.browserBinding }),
      }))

      const route = readRoute(await engine.complete({
        instruction: 'Analyze the task. Choose the eligible AI provider whose suitableTasks best matches it. Provider candidates include the current profile plan and known remaining capacity after deterministic exclusions. Treat unknown capacity as uncertainty, not an unlimited allowance. Return that provider ID, its configured model, the task type, complexity, and a concise reason.',
        input: {
          task: input.taskPrompt,
          providerConfiguration: input.providers.map((provider) => ({ ...provider })),
        },
        responseSchema: {
          type: 'object',
          properties: {
            providerId: { type: 'string', enum: input.providers.map((provider) => provider.providerId) },
            model: { enum: [...new Set(input.providers.map((provider) => provider.model))] },
            taskType: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,31}$' },
            complexity: { type: 'string', enum: ['low', 'medium', 'high'] },
            reason: { type: 'string' },
          },
          required: ['providerId', 'model', 'taskType', 'complexity', 'reason'],
          additionalProperties: false,
        },
        ...(input.browserBinding === undefined ? {} : { browserBinding: input.browserBinding }),
      }), input.providers)

      return {
        protocol: HARNESS_SIDECAR_PROTOCOL,
        kind: 'front_door',
        engine: engine.id,
        title,
        route,
      }
    },
  }
}

export function createHarnessExitDoorSidecar(engine: HarnessAiEngine): HarnessExitDoorSidecar {
  return {
    async finalize(input) {
      if (!input.output.trim()) throw new HarnessSidecarError('harness_exit_door_input_invalid', 'Exit Door output must not be empty.')
      const result = readExitResult(await engine.complete({
        instruction: 'Review the completed task result. Return a concise summary and a small set of useful labels. Do not change the result or invent facts.',
        input: {
          taskPrompt: input.taskPrompt.slice(0, 4_000),
          output: input.output.slice(0, 12_000),
          artifacts: [...input.artifacts],
        },
        responseSchema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'labels'],
          additionalProperties: false,
        },
        ...(input.browserBinding === undefined ? {} : { browserBinding: input.browserBinding }),
      }))
      return {
        protocol: HARNESS_SIDECAR_PROTOCOL,
        kind: 'exit_door',
        engine: engine.id,
        ...result,
      }
    },
  }
}

function readTitle(value: HarnessSidecarJsonValue) {
  const record = readRecord(value, 'Front Door title')
  const title = record.title
  if (typeof title !== 'string' || title.trim() === '' || title.trim().length > 80) {
    throw new HarnessSidecarError('harness_front_door_result_invalid', 'Front Door returned an invalid title.')
  }
  return title.trim()
}

function readSparkToolArguments(value: unknown): HarnessSidecarJsonValue {
  const completion = readUnknownRecord(value, 'Spark MLX completion')
  const choices = completion.choices
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new HarnessSidecarError(
      'harness_spark_tool_call_invalid',
      'Spark MLX response must contain exactly one completion choice.',
    )
  }
  const choice = readUnknownRecord(choices[0], 'Spark MLX completion choice')
  const message = readUnknownRecord(choice.message, 'Spark MLX completion message')
  const toolCalls = message.tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new HarnessSidecarError(
      'harness_spark_tool_call_invalid',
      'Spark MLX response must contain exactly one tool call.',
    )
  }
  const toolCall = readUnknownRecord(toolCalls[0], 'Spark MLX tool call')
  const functionCall = readUnknownRecord(toolCall.function, 'Spark MLX function call')
  if (
    toolCall.type !== 'function'
    || functionCall.name !== SPARK_X25_4B_MLX_TOOL_NAME
    || typeof functionCall.arguments !== 'string'
  ) {
    throw new HarnessSidecarError(
      'harness_spark_tool_call_invalid',
      `Spark MLX response must contain one '${SPARK_X25_4B_MLX_TOOL_NAME}' function call.`,
    )
  }
  try {
    return JSON.parse(functionCall.arguments) as HarnessSidecarJsonValue
  } catch {
    throw new HarnessSidecarError(
      'harness_spark_tool_call_invalid',
      `Spark MLX '${SPARK_X25_4B_MLX_TOOL_NAME}' arguments were not valid JSON.`,
    )
  }
}

function readUnknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HarnessSidecarError('harness_spark_response_invalid', `${label} must be a JSON object.`)
  }
  return value as Record<string, unknown>
}

function readRoute(value: HarnessSidecarJsonValue, candidates: HarnessFrontDoorInput['providers']): HarnessFrontDoorRoute {
  const record = readRecord(value, 'Front Door route')
  const providerId = record.providerId
  const model = record.model
  const taskType = record.taskType
  const complexity = record.complexity
  const reason = record.reason
  const candidate = candidates.find((item) => item.providerId === providerId)
  if (
    typeof providerId !== 'string' ||
    !candidate ||
    model !== candidate.model ||
    typeof taskType !== 'string' ||
    !ROUTER_TASK_TYPE_PATTERN.test(taskType) ||
    !['low', 'medium', 'high'].includes(String(complexity)) ||
    typeof reason !== 'string'
  ) {
    throw new HarnessSidecarError('harness_front_door_result_invalid', 'Front Door returned an invalid route.')
  }
  return {
    providerId,
    model: candidate.model,
    taskType,
    complexity: complexity as HarnessFrontDoorRoute['complexity'],
    reason,
  }
}

function readExitResult(value: HarnessSidecarJsonValue): Pick<HarnessExitDoorResult, 'summary' | 'labels'> {
  const record = readRecord(value, 'Exit Door result')
  const summary = record.summary
  const labels = record.labels
  if (typeof summary !== 'string' || summary.trim() === '' || !Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
    throw new HarnessSidecarError('harness_exit_door_result_invalid', 'Exit Door returned an invalid result.')
  }
  return { summary: summary.trim(), labels: labels.map((label) => String(label).trim()).filter(Boolean).slice(0, 16) }
}

function readRecord(value: HarnessSidecarJsonValue, label: string): Record<string, HarnessSidecarJsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessSidecarError('harness_sidecar_result_invalid', `${label} must be a JSON object.`)
  }
  return value
}
