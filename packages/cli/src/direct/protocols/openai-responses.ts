import { invalidResponseError, normalizeResponseRequestId } from '../api-transport.js'
import {
  INVALID_NONNEGATIVE_INTEGER,
  isRecord,
  optionalNonnegativeInteger,
} from '../request-validation.js'
import type { DirectRunRequest, DirectUsage } from '../types.js'

export function openAiResponsesBody(request: DirectRunRequest, model: string) {
  return {
    model,
    input: request.prompt,
    stream: false,
    store: false,
    ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
}

export function extractOpenAiResponseText(raw: Record<string, unknown>, requestId: string | undefined) {
  if (!Array.isArray(raw.output)) {
    throw invalidResponseError('The direct API response did not contain assistant text.', requestId)
  }

  const blocks: string[] = []
  for (const output of raw.output) {
    if (!isRecord(output) || output.type !== 'message' || !Array.isArray(output.content)) continue
    for (const content of output.content) {
      if (!isRecord(content)) continue
      if (content.type === 'output_text' && typeof content.text === 'string') blocks.push(content.text)
      if (content.type === 'refusal' && typeof content.refusal === 'string') blocks.push(content.refusal)
    }
  }
  if (blocks.length === 0) {
    throw invalidResponseError('The direct API response did not contain assistant text or a refusal.', requestId)
  }
  return blocks.join('\n')
}

export function normalizeOpenAiUsage(value: unknown): DirectUsage | undefined {
  if (!isRecord(value)) return undefined
  const rawInputTokens = optionalNonnegativeInteger(value, 'input_tokens')
  const rawOutputTokens = optionalNonnegativeInteger(value, 'output_tokens')
  const rawTotalTokens = optionalNonnegativeInteger(value, 'total_tokens')
  const inputTokens = rawInputTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawInputTokens
  const outputTokens = rawOutputTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawOutputTokens
  const totalTokens = rawTotalTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawTotalTokens
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}

export function openAiBodyRequestId(raw: Record<string, unknown>, apiKey: string) {
  return normalizeResponseRequestId(raw.request_id, apiKey)
}
