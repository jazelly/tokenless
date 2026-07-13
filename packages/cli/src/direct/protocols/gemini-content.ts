import { invalidResponseError } from '../api-transport.js'
import {
  INVALID_NONNEGATIVE_INTEGER,
  isRecord,
  optionalNonnegativeInteger,
  safeNonnegativeSum,
} from '../request-validation.js'
import type { DirectRunRequest, DirectUsage } from '../types.js'

export function geminiGenerateContentBody(request: DirectRunRequest) {
  const generationConfig = {
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
  return {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    store: false,
    ...(Object.keys(generationConfig).length === 0 ? {} : { generationConfig }),
  }
}

export function extractGeminiCandidateText(raw: Record<string, unknown>, requestId: string | undefined) {
  const firstCandidate = Array.isArray(raw.candidates) ? raw.candidates[0] : undefined
  if (!isRecord(firstCandidate) || !isRecord(firstCandidate.content) || !Array.isArray(firstCandidate.content.parts)) {
    throw invalidResponseError('The Gemini response did not contain candidate text.', requestId)
  }
  const blocks: string[] = []
  for (const part of firstCandidate.content.parts) {
    if (isRecord(part) && part.thought !== true && typeof part.text === 'string') blocks.push(part.text)
  }
  if (blocks.length === 0) {
    throw invalidResponseError('The Gemini response did not contain candidate text.', requestId)
  }
  return blocks.join('\n')
}

export function normalizeGeminiUsage(value: unknown): DirectUsage | undefined {
  if (!isRecord(value)) return undefined
  const rawInputTokens = optionalNonnegativeInteger(value, 'promptTokenCount')
  const candidateTokens = optionalNonnegativeInteger(value, 'candidatesTokenCount')
  const thoughtTokens = optionalNonnegativeInteger(value, 'thoughtsTokenCount')
  const rawTotalTokens = optionalNonnegativeInteger(value, 'totalTokenCount')
  const inputTokens = rawInputTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawInputTokens
  const outputTokens =
    candidateTokens === INVALID_NONNEGATIVE_INTEGER || thoughtTokens === INVALID_NONNEGATIVE_INTEGER
      ? undefined
      : safeNonnegativeSum([candidateTokens, thoughtTokens])
  const totalTokens = rawTotalTokens === INVALID_NONNEGATIVE_INTEGER ? undefined : rawTotalTokens
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  }
}
