export const HARNESS_SIDECAR_PROTOCOL = 'tokenless.harness-sidecar/v1' as const
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
        instruction: 'Analyze the task. Choose the enabled AI provider whose suitableTasks best matches it. Return that provider ID, its configured model, the task type, complexity, and a concise reason.',
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
