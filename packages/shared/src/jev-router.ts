/**
 * Pure, network-free helpers shared between the dashboard (browser) and the
 * server for TypeSafe's Jev ("System One") router engine. Jev only returns
 * typed judgments (Choice/Noul/Score) -- it cannot generate free text, so the
 * request shaping and title heuristic here deliberately avoid asking it for
 * prose. The actual HTTP call to TypeSafe stays server-side.
 */
import type { HarnessFrontDoorProviderCandidate, HarnessFrontDoorRoute } from './harness-sidecar.js'

export const JEV_ENGINE_ID = 'jev' as const
export const JEV_MODEL = 'jev-latest' as const

/** Fixed task taxonomy asked of Jev as a Choice question alongside provider selection. */
export const JEV_TASK_TYPE_TAXONOMY = {
  writing: 'Drafting, editing, or rewriting prose, copy, or documentation.',
  coding: 'Writing, reviewing, or debugging code.',
  research: 'Finding, summarizing, or synthesizing information.',
  analysis: 'Reasoning about data, comparing options, or structured judgment.',
  conversation: 'Open-ended chat, brainstorming, or question answering.',
  other: 'Anything that does not fit the categories above.',
} as const

export type JevTaskType = keyof typeof JEV_TASK_TYPE_TAXONOMY

/** Score rubric levels, indexed 0-2, mapped to HarnessFrontDoorRoute['complexity']. */
export const JEV_COMPLEXITY_CRITERIA = [
  'Simple, well-defined, low risk if handled by a generic assistant.',
  'Moderate: requires some judgment or multiple steps.',
  'Complex, high-stakes, or best handled by a specialist.',
] as const

export const JEV_COMPLEXITY_LEVELS = ['low', 'medium', 'high'] as const

/** Mirrors the TypeSafe SDK's JsonValue/EntryType shapes without depending on the SDK package. */
type JevJsonValue = string | number | boolean | null | JevJsonValue[] | { [key: string]: JevJsonValue }
type JevEntryType = string | { [key: string]: JevJsonValue } | JevJsonValue[] | null

export type JevChoiceCriteria = Record<string, JevEntryType>

/** Shape of the batched systemOne request body Jev routing sends. */
export type JevRouteQuestions = {
  providerId: { type: 'choice', instructions: string, criteria: JevChoiceCriteria }
  taskType: { type: 'choice', instructions: string, criteria: typeof JEV_TASK_TYPE_TAXONOMY }
  complexity: { type: 'score', instructions: string, criteria: typeof JEV_COMPLEXITY_CRITERIA }
}

export function buildJevRouteQuestions(
  task: string,
  providers: readonly HarnessFrontDoorProviderCandidate[],
): JevRouteQuestions {
  const providerCriteria: JevChoiceCriteria = Object.fromEntries(providers.map((provider) => [
    provider.providerId,
    {
      label: provider.label,
      suitable_for: provider.suitableTasks,
      plan: provider.plan.label ?? provider.plan.planId,
    },
  ]))
  return {
    providerId: {
      type: 'choice',
      instructions: `Choose the eligible AI provider whose suitableTasks best matches this task: ${task}`,
      criteria: providerCriteria,
    },
    taskType: {
      type: 'choice',
      instructions: `Classify this task into one category: ${task}`,
      criteria: JEV_TASK_TYPE_TAXONOMY,
    },
    complexity: {
      type: 'score',
      instructions: `Rate how complex this task is to resolve: ${task}`,
      criteria: JEV_COMPLEXITY_CRITERIA,
    },
  }
}

export type JevChoiceAnswer = { type: 'choice', choice: string, confidence: number, probabilities: Record<string, number> }
export type JevScoreAnswer = { type: 'score', score: number, confidence: number, probabilities: Record<string, number> }

export type JevRouteAnswers = {
  providerId: JevChoiceAnswer
  taskType: JevChoiceAnswer
  complexity: JevScoreAnswer
}

export class JevRouteError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'JevRouteError'
    this.code = code
  }
}

/** Map Jev's typed answers plus the original candidates into a HarnessFrontDoorRoute, synthesizing `reason` in code. */
export function readJevRoute(
  answers: JevRouteAnswers,
  providers: readonly HarnessFrontDoorProviderCandidate[],
): HarnessFrontDoorRoute {
  const candidate = providers.find((provider) => provider.providerId === answers.providerId.choice)
  if (!candidate) {
    throw new JevRouteError('jev_route_result_invalid', `Jev selected an unknown provider: ${answers.providerId.choice}`)
  }
  const taskType = answers.taskType.choice
  if (!(taskType in JEV_TASK_TYPE_TAXONOMY)) {
    throw new JevRouteError('jev_route_result_invalid', `Jev returned an unknown task type: ${taskType}`)
  }
  const levelIndex = Math.round(Math.min(2, Math.max(0, answers.complexity.score)))
  const complexity = JEV_COMPLEXITY_LEVELS[levelIndex]!
  const providerConfidencePct = Math.round(answers.providerId.confidence * 100)
  const complexityConfidencePct = Math.round(answers.complexity.confidence * 100)
  const reason = `Jev selected '${candidate.providerId}' with ${providerConfidencePct}% confidence; `
    + `classified as '${taskType}' and rated '${complexity}' complexity (${complexityConfidencePct}% confidence).`
  return {
    providerId: candidate.providerId,
    model: candidate.model,
    taskType,
    complexity,
    reason,
  }
}

/**
 * Deterministic, network-free title heuristic used when the router engine is
 * Jev, since typed judgments cannot generate free text. Mirrors the length
 * constraint the other engines are instructed to follow.
 */
export function deriveJevHeuristicTitle(task: string): string {
  const trimmed = task.trim().replace(/\s+/gu, ' ')
  if (!trimmed) return 'Untitled task'
  const isCjk = /[぀-ヿ㐀-鿿豈-﫿]/u.test(trimmed)
  if (isCjk) return trimmed.length > 20 ? `${trimmed.slice(0, 20)}...` : trimmed
  const words = trimmed.split(' ')
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}...` : trimmed
}
